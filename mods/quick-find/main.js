// Quick find: Ctrl+P-style file finder and project-wide text search for the focused pane's
// folder. Opens results in the `file-viewer` tab used by `my-files`.
// Files mode: git ls-files (or rg --files / PowerShell) + fuzzy match. Text mode: rg, else git grep.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, ScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, run, shared, setShared, props, closeOverlay, theme, window, readTextFile, settings } from "herdr";

import { lex, family } from "./highlight.js";

// Token kinds from ./highlight.js (copied from file-viewer) -> theme colors.
function palette(t) {
  return { plain: t.foreground, key: t.ansi4, string: t.ansi2, number: t.ansi1, constant: t.ansi6, keyword: t.ansi5,
    function: t.ansi4, type: t.ansi3, comment: t.dim, punct: t.muted, meta: t.ansi6, section: t.ansi5, tag: t.ansi5,
    attr: t.ansi3, added: t.ansi2, removed: t.ansi1, hunk: t.ansi6 };
}

const VIEWER = "file-viewer", OPEN = "file-viewer:open";
const MAX_FILES = 100000, SHOW = 60, MAX_HITS = 200;
const docKey = (file, on) => `${on ?? ""}|${file}`;
const tabOf = (entry) => typeof entry === "string" ? entry : entry?.tab;
const hasViewer = (tab) => panes().some(p => p.tab === tab && p.mod === VIEWER);

// Same folder logic as my-files: the focused pane's cwd, or the root a file tab was opened from.
function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  if (pane?.mod === VIEWER) {
    const hit = Object.entries(shared(OPEN) ?? {}).find(([, v]) => tabOf(v) === f.tab);
    if (hit) {
      const [k, v] = hit, bar = k.indexOf("|"), file = k.slice(bar + 1);
      return { cwd: v?.root ?? (file.replace(/[\\/][^\\/]*$/, "") || "/"), on: k.slice(0, bar) || null };
    }
  }
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

function score(path, tokens) {
  const lower = path.toLowerCase(), base = lower.slice(lower.lastIndexOf("/") + 1);
  let total = 0;
  for (const t of tokens) {
    if (base.startsWith(t)) total += 100;
    else if (base.includes(t)) total += 80;
    else if (lower.includes(t)) total += 50;
    else {
      let i = 0;
      for (const ch of lower) if (ch === t[i]) i++;
      if (i < t.length) return -1;
      total += 10;
    }
  }
  return total * 1000 - path.length;
}

const PS_LIST = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); & { param($p) Get-ChildItem -LiteralPath $p -Recurse -File -Force -Name -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch '(^|\\\\)(node_modules|\\.git)(\\\\|$)' } | Select-Object -First 100001 } ";

// Text search with no ripgrep and no git (Windows): every file under the folder, any depth, minus
// dependency/build folders and binary types. Case-insensitive, literal; the first 200 hits.
const PS_GREP = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); & { param($p,$q) Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.Length -lt 1MB -and $_.FullName -notmatch '[\\\\/](node_modules|\\.git|dist|build|\\.next|__pycache__|\\.venv|venv)[\\\\/]' -and $_.Extension -notmatch '^\\.(png|jpe?g|gif|webp|ico|pdf|zip|rar|7z|gz|exe|dll|bin|mp3|mp4|mov|avi|woff2?|ttf|otf|pyc|class|jar|iso|psd|docx?|xlsx?|pptx?|p12)$' } | Select-String -SimpleMatch -Pattern $q -ErrorAction SilentlyContinue | Select-Object -First 200 | ForEach-Object { $_.Path + ':' + $_.LineNumber + ':' + $_.Line } } ";
const psq = (v) => "'" + String(v).replaceAll("'", "''") + "'";

export default class QuickFind extends View {
  init(_props, cx) {
    const loc = location();
    this.root = loc.cwd; this.on = loc.on;
    this.mode = "files"; this.files = null; this.rows = []; this.sel = 0;
    this.status = "Loading files…"; this.engine = null; this.busy = false; this.timer = null; this.seq = 0;
    this.preview = null; this.pseq = 0; this.cache = new Map();
    this.scroll = ScrollHandle.new();
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Find files by name…" });
    this.input.on("change", (_e, cx) => this.changed(cx));
    this.input.on("submit", (_e, cx) => this.open(cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    if (!this.root) { this.status = "No folder"; return; }
    this.loadFiles(cx);
  }

  async isGit() {
    const r = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: this.root, on: this.on }).catch(() => null);
    return r?.code === 0 && r.stdout.trim() === "true";
  }

  loadFiles(cx) {
    cx.spawn(async (cx) => {
      let paths = [];
      try {
        if (await this.isGit()) {
          const r = await exec("git", ["--no-optional-locks", "ls-files", "-z", "-c", "-o", "--exclude-standard"], { cwd: this.root, on: this.on }).catch(() => null);
          if (r?.code === 0) paths = r.stdout.split("\0");
        }
        if (!paths.length) {
          const r = await exec("rg", ["--files", "--hidden", "-g", "!.git", "--null"], { cwd: this.root, on: this.on }).catch(() => null);
          if (r?.stdout) paths = r.stdout.split("\0");
        }
        if (!paths.length && !this.on && window()?.platform === "windows") {
          const r = await exec("powershell", ["-NoProfile", "-Command", PS_LIST + "'" + this.root.replaceAll("'", "''") + "'"]).catch(() => null);
          if (r?.stdout) paths = r.stdout.split(/\r?\n/).map(p => p.replaceAll("\\", "/"));
        }
      } catch {}
      this.files = paths.filter(p => p && p !== ".git" && !p.startsWith(".git/")).slice(0, MAX_FILES);
      this.status = paths.length > MAX_FILES ? `${MAX_FILES}+ files (list cut off)` : `${this.files.length} files`;
      this.changed(cx);
    });
  }

  changed(cx) {
    this.sel = 0;
    if (this.mode === "files") { this.filter(); cx.notify(); return; }
    const q = this.input.value().trim();
    this.timer?.cancel();
    if (!q) { this.rows = []; this.status = "Type to search file contents"; cx.notify(); return; }
    this.status = "Searching…"; cx.notify();
    const seq = ++this.seq;
    this.timer = cx.timer.after(250, (cx) => {
      this.timer = null;
      cx.spawn(async (cx) => { await this.grep(q, seq); this.loadPreview(cx); cx.notify(); });
    });
  }

  // Code preview around the selected/hovered text hit: the file read once (cached), a window of lines.
  loadPreview(cx) {
    const row = this.mode === "text" ? this.rows[this.sel] : null;
    if (!row) { this.preview = null; return; }
    const seq = ++this.pseq, file = `${this.root}/${row.path}`, on = this.on;
    const show = (lines) => {
      const start = Math.max(0, row.line - 9), end = Math.min(lines.length, start + 24);
      const clean = (l) => l.replaceAll("\t", "  ").slice(0, 2000);
      // Lex from a bit earlier so a comment or string that began above the window is still colored.
      const from = Math.max(0, start - 60);
      let toks = null;
      try { toks = lex(lines.slice(from, end).map(clean).join("\n"), family(row.path)).slice(start - from); } catch {}
      this.preview = { path: row.path, line: row.line, start, lines: lines.slice(start, end).map(clean), toks };
    };
    const cached = this.cache.get(file);
    if (cached) { show(cached); return; }
    cx.spawn(async (cx) => {
      let lines = null;
      try {
        const text = await readTextFile(file, { on });
        if (text !== null && !text.includes("\0")) lines = text.split(/\r?\n/);
      } catch {}
      if (seq !== this.pseq) return;
      if (lines) { if (this.cache.size > 30) this.cache.clear(); this.cache.set(file, lines); show(lines); }
      else this.preview = { path: row.path, line: row.line, start: 0, lines: [], error: "No text preview (binary, too large or unreadable)" };
      cx.notify();
    });
  }

  filter() {
    const files = this.files ?? [], tokens = this.input.value().trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) { this.rows = files.slice(0, SHOW).map(path => ({ path })); return; }
    const scored = [];
    for (const path of files) { const s = score(path, tokens); if (s >= 0) scored.push([s, path]); }
    scored.sort((a, b) => b[0] - a[0]);
    this.rows = scored.slice(0, SHOW).map(([, path]) => ({ path }));
    this.status = `${scored.length} match${scored.length === 1 ? "" : "es"}`;
  }

  async grep(q, seq) {
    const opts = { cwd: this.root, on: this.on };
    if (this.engine === null) {
      const rg = await exec("rg", ["--version"], opts).catch(() => null);
      this.engine = rg?.code === 0 ? "rg" : (await this.isGit()) ? "git" : (!this.on && window()?.platform === "windows") ? "ps" : "none";
    }
    if (this.engine === "none") { this.rows = []; this.status = "Text search needs ripgrep (rg) or a git repository"; return; }
    const r = this.engine === "ps"
      ? await exec("powershell", ["-NoProfile", "-Command", PS_GREP + psq(this.root) + " " + psq(q)], { timeout: 90000 }).catch(() => null)
      : this.engine === "rg"
      ? await exec("rg", ["--vimgrep", "--smart-case", "--fixed-strings", "--max-count", "5", "-g", "!.git", "--", q], opts).catch(() => null)
      : await exec("git", ["--no-optional-locks", "grep", "-n", "-I", "-i", "-F", "--untracked", "-e", q], opts).catch(() => null);
    if (seq !== this.seq) return;
    const rows = [];
    for (const l of (r?.stdout ?? "").split(/\r?\n/)) {
      const m = this.engine === "rg" ? /^(.*?):(\d+):\d+:(.*)$/.exec(l) : /^(.*?):(\d+):(.*)$/.exec(l);
      if (!m) continue;
      let path = m[1].replaceAll("\\", "/");
      if (this.engine === "ps") {
        const root = this.root.replaceAll("\\", "/").replace(/\/+$/, "");
        if (path.toLowerCase().startsWith(root.toLowerCase() + "/")) path = path.slice(root.length + 1);
      }
      rows.push({ path, line: Number(m[2]), text: m[3].trim().slice(0, 200) });
      if (rows.length >= MAX_HITS) break;
    }
    this.rows = rows;
    this.status = rows.length ? `${rows.length}${rows.length >= MAX_HITS ? "+" : ""} results` : "No results";
  }

  setMode(mode, cx) {
    this.mode = mode;
    this.input.set_value("");
    this.input.focus();
    this.rows = []; this.sel = 0; this.preview = null; this.pseq++;
    if (mode === "files") { this.status = this.files ? `${this.files.length} files` : "Loading files…"; this.filter(); }
    else this.status = "Type to search file contents";
    cx.notify();
  }

  // Same bookkeeping as my-files.open: reuse an open tab, else a new file-viewer tab that is
  // registered in shared(OPEN) so my-files recognises it. The dialog stays until it is registered.
  open(cx) {
    const row = this.rows[this.sel];
    if (!row || this.busy || !this.root) return;
    this.busy = true;
    const file = `${this.root}/${row.path}`, on = this.on, key = docKey(file, on);
    const open = { ...(shared(OPEN) ?? {}) }, tab = tabOf(open[key]), overlay = props()?.overlay;
    if (tab && hasViewer(tab)) { closeOverlay(overlay); run("tab.select", { id: tab }); return; }
    if (open[key]) { delete open[key]; setShared(OPEN, open); }
    const before = new Set(panes().filter(p => p.mod === VIEWER).map(p => p.pane)), root = this.root;
    run("tab.new", { name: row.path.split("/").pop(), mod: VIEWER, props: { file, on } });
    const claim = (n) => (cx) => {
      const fresh = panes().find(p => p.mod === VIEWER && !before.has(p.pane));
      if (fresh) { setShared(OPEN, { ...(shared(OPEN) ?? {}), [key]: { tab: fresh.tab, root } }); closeOverlay(overlay); }
      else if (n < 20) cx.timer.after(100, claim(n + 1));
      else closeOverlay(overlay);
    };
    cx.timer.after(50, claim(0));
  }

  move(by, cx) {
    if (!this.rows.length) return;
    this.sel = (this.sel + by + this.rows.length) % this.rows.length;
    this.scroll.scroll_to_item(this.sel);
    this.loadPreview(cx);
    cx.notify();
  }

  // One line as colored spans; plain text if the lexer gave nothing for it.
  code(t, pal, tokens, line, hit) {
    const row = h_flex().flex_1().whitespace_nowrap();
    if (!tokens?.length) return row.child(div().text_color(hit ? t.foreground : t.muted).child(line || " "));
    return row.children(tokens.map(([kind, text]) => div().flex_none().whitespace_nowrap().text_color(pal[kind] ?? t.foreground).child(text)));
  }

  previewPane(t) {
    const p = this.preview, font = settings().font_family, pal = palette(t);
    const box = v_flex().id("qf-preview").flex_1().min_w(0).min_h(0).overflow_hidden().rounded(8).border_1().border_color(t.border).bg(t.background);
    if (!p) return box.child(div().p(12).text_size(12).text_color(t.dim).child("Hover a result to preview it"));
    return box
      .child(div().h(28).flex_none().px(10).flex().items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.dim).truncate().child(`${p.path}:${p.line}`))
      .child(p.error ? div().p(12).text_size(12).text_color(t.dim).child(p.error)
        // Horizontal scroll: the inner column is as wide as the longest line (about 7.3px per char).
        : v_flex().id("qf-pscroll").w_full().h(24 * 17 + 8 + 12).flex_none().overflow_x_scrollbar()
          .child(v_flex().py(4).flex_none().w(Math.max(300, Math.ceil(Math.max(...p.lines.map(l => l.length), 0) * 7.3) + 80))
            .children(p.lines.map((l, i) => {
              const n = p.start + i + 1, hit = n === p.line;
              return h_flex().id(`qf-pl-${n}`).w_full().h(17).flex_none().px(8).gap(10).items_center().text_size(12).font_family(font)
                .when(hit, el => el.bg(t.selected))
                .child(div().w(34).flex_none().text_right().text_color(t.dim).child(String(n)))
                .child(this.code(t, pal, p.toks?.[i], l, hit));
            }))));
  }

  render(cx) {
    const t = theme(), text = this.mode === "text";
    const tab = (id, label, mode) => div().id(id).h(24).px(10).flex().items_center().rounded(6).text_size(12).cursor_pointer()
      .when(this.mode === mode, el => el.bg(t.raised).text_color(t.foreground))
      .when(this.mode !== mode, el => el.text_color(t.muted).hover(s => s.text_color(t.foreground)))
      .on_click((_e, cx) => this.setMode(mode, cx)).child(label);
    return v_flex().id("quick-find").track_focus(this.handle).size_full().min_h(0).p(14).gap(10).bg(t.popover).text_color(t.foreground).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { closeOverlay(props()?.overlay); cx.stop_propagation(); }
        else if (e.key === "down") { this.move(1, cx); cx.stop_propagation(); }
        else if (e.key === "up") { this.move(-1, cx); cx.stop_propagation(); }
        else if (e.key === "enter") { this.open(cx); cx.stop_propagation(); }
        else if (e.key === "tab") { this.setMode(text ? "files" : "text", cx); cx.stop_propagation(); }
      })
      .child(h_flex().gap(6).items_center()
        .child(tab("qf-files", "Files", "files")).child(tab("qf-text", "Text", "text"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(t.dim).child(this.root ?? "")))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(h_flex().flex_1().min_h(0).gap(10)
        .child(v_flex().id("qf-list").flex_1().min_w(0).min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).gap(1)
          .children(this.rows.map((r, i) => h_flex().id(`qf-${i}`).w_full().h(text ? 40 : 28).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
            .when(i === this.sel, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
            .on_hover((hovered, cx) => { if (hovered && text && this.sel !== i) { this.sel = i; this.loadPreview(cx); cx.notify(); } })
            .on_click((_e, cx) => { this.sel = i; this.open(cx); })
            .child(text
              ? v_flex().flex_1().min_w(0).child(div().truncate().text_size(12).child(`${r.path}:${r.line}`)).child(div().truncate().text_size(11).text_color(t.dim).child(r.text))
              : div().flex_1().min_w(0).truncate().child(r.path)))))
        .when(text, el => el.child(this.previewPane(t))))
      .child(h_flex().gap(10).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().child(this.status))
        .child(div().child("↑↓ move · Enter open · Tab switch mode · Esc close")));
  }
}
