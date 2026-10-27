import {
  App, Notice, Plugin, PluginSettingTab, Setting, TFile,
  normalizePath, requestUrl, Modal, Platform
} from "obsidian";
import { PDFDocument } from "pdf-lib";
import { spawn, execSync } from "child_process";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseTTF, TTFont } from "./ttf";
import { transformPdf, extractPageTexts } from "./transform";

const CACHE_DIR = "clearread-cache";
const CACHE_VERSION = "v10";
const BUILD_ID = "2025-tts-v4-autosetup";
const RULER_OVERLAY_CLASS = "clearread-ruler-overlay";
const PIPER_VOICE = "en_US-lessac-medium";

const THEMES = ["none", "dark", "sepia", "contrast", "gray"] as const;
type Theme = typeof THEMES[number];
const RULERS = ["off", "ruler", "mask"] as const;
type RulerMode = typeof RULERS[number];

const FONT_PRESETS: Record<string, string> = {
  "AtkinsonHyperlegible-Regular.ttf":
    "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/atkinsonhyperlegible/AtkinsonHyperlegible-Regular.ttf",
  "AtkinsonHyperlegible-Bold.ttf":
    "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/atkinsonhyperlegible/AtkinsonHyperlegible-Bold.ttf",
  "ComicNeue-Regular.ttf":
    "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/comicneue/ComicNeue-Regular.ttf",
  "OpenDyslexic-Regular.ttf":
    "https://cdn.jsdelivr.net/gh/alm-typeface/open-dyslexic@master/ttf/OpenDyslexic-Regular.ttf"
};

interface ClearReadSettings {
  fontPaths: string[];
  autoFriendly: boolean;
  theme: Theme;
  ruler: RulerMode;
  ttsEnabled: boolean;
  ttsCommand: string;
}
const DEFAULTS: ClearReadSettings = {
  fontPaths: [], autoFriendly: false, theme: "none", ruler: "off",
  ttsEnabled: false, ttsCommand: ""
};

interface FontEntry { name: string; path: string; system: boolean }

interface CacheInfo {
  version: string;
  source: string;
  texts: string[];
}

export default class ClearReadPlugin extends Plugin {
  settings: ClearReadSettings = DEFAULTS;
  systemFonts: FontEntry[] = [];
  parsedFonts = new Map<string, TTFont>();
  infoCache = new Map<string, CacheInfo>();
  ttsChild: ChildProcess | null = null;
  binCache = new Map<string, boolean>();
  ttsPython: string | null = null;
  setupRunning = false;

  async onload(): Promise<void> {
    console.log(`[ClearRead] build ${BUILD_ID} loaded`);
    const data: any = await this.loadData();
    this.settings = Object.assign({}, DEFAULTS, data);
    if (!this.settings.fontPaths?.length && data?.substituteFontPath) {
      this.settings.fontPaths = [data.substituteFontPath];
    }
    if (!Array.isArray(this.settings.fontPaths)) this.settings.fontPaths = [];

    this.addCommand({
      id: "clearread-open-friendly",
      name: "Open dyslexia-friendly version of current PDF",
      callback: () => { void this.openFriendly(); }
    });
    this.addCommand({
      id: "clearread-choose-font",
      name: "Choose ClearRead font",
      callback: () => {
        new FontChooserModal(this.app, this, (entry) => {
          void this.makePrimary(entry).then(() => this.openFriendly());
        }).open();
      }
    });
    this.addCommand({
      id: "clearread-clear-cache",
      name: "Clear ClearRead cache",
      callback: () => { void this.clearCache(); }
    });
    this.addCommand({
      id: "clearread-cycle-theme",
      name: "Cycle reading theme",
      callback: () => { this.cycleTheme(); }
    });
    this.addCommand({
      id: "clearread-cycle-ruler",
      name: "Cycle reading ruler / focus mask",
      callback: () => { this.cycleRuler(); }
    });

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== "pdf") return;
      menu.addItem((item) =>
        item.setTitle("Open dyslexia-friendly version").setIcon("book-open")
          .onClick(() => { void this.openFriendly(file); }));
    }));

    this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshViews()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshViews()));
    this.registerEvent(this.app.workspace.on("file-open", (file) => {
      this.refreshViews();
      if (
        this.settings.autoFriendly &&
        file instanceof TFile &&
        file.extension === "pdf" &&
        !file.path.startsWith(CACHE_DIR + "/")
      ) {
        window.setTimeout(() => { void this.openFriendly(file); }, 150);
      }
    }));
    window.setTimeout(() => this.refreshViews(), 600);

    this.addSettingTab(new ClearReadSettingTab(this.app, this));
  }

  onunload(): void {
    this.stopAllTTS();
    document.querySelectorAll(
      ".clearread-bar, .clearread-focus-overlay, .clearread-ruler-overlay"
    ).forEach((el) => el.remove());
    const prev = (window as any).__clearreadRulerMove;
    if (typeof prev === "function") {
      document.removeEventListener("pointermove", prev);
      (window as any).__clearreadRulerMove = null;
    }
  }

  // ---------------- TTS: env, discovery, auto-setup ----------------

  private ttsEnv(): NodeJS.ProcessEnv {
    const home = os.homedir();
    const extra = [
      path.join(home, ".local", "bin"),
      path.join(home, "bin"),
      "/usr/local/bin",
      "/usr/bin",
      "/bin"
    ];
    return {
      ...process.env,
      PATH: [process.env.PATH || "", ...extra].join(":")
    };
  }

  hasBin(name: string): boolean {
    const hit = this.binCache.get(name);
    if (hit !== undefined) return hit;
    let ok = false;
    try {
      const cmd = process.platform === "win32" ? `where ${name}` : `command -v ${name}`;
      execSync(cmd, { stdio: "ignore", env: this.ttsEnv() });
      ok = true;
    } catch { ok = false; }
    this.binCache.set(name, ok);
    return ok;
  }

  // Plugin-owned, user-agnostic voice dir (no hardcoded usernames)
  ttsVoiceDir(): string {
    return path.join(os.homedir(), ".clearread-tts");
  }

  findPiperModel(): string | null {
    const home = os.homedir();
    const dirs = [
      this.ttsVoiceDir(),
      path.join(home, ".local", "share", "piper"),
      path.join(home, "piper"),
      path.join(home, "Downloads"),
      home
    ];
    for (const d of dirs) {
      let files: string[] = [];
      try { files = fs.readdirSync(d); } catch { continue; }
      const onnx = files.filter((f) => f.endsWith(".onnx"));
      if (!onnx.length) continue;
      const withCfg = onnx.find((f) => fs.existsSync(path.join(d, f + ".json")));
      return path.join(d, withCfg || onnx[0]);
    }
    return null;
  }

  discoverPython(): string | null {
    if (this.ttsPython) return this.ttsPython;
    try {
      const cmd = process.platform === "win32"
        ? "where python"
        : "command -v python3 || command -v python";
      const out = execSync(cmd, {
        env: this.ttsEnv(), stdio: ["ignore", "pipe", "ignore"]
      }).toString().trim().split("\n")[0];
      if (out) { this.ttsPython = out; return out; }
    } catch {}
    if (process.platform === "win32") { this.ttsPython = "python"; return "python"; }
    return null;
  }

  private runCmd(cmd: string, args: string[], cwd?: string): Promise<boolean> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(cmd, args, {
          env: this.ttsEnv(),
          cwd: cwd || os.homedir(),
          stdio: ["ignore", "ignore", "pipe"]
        });
      } catch { resolve(false); return; }
      child.stderr?.on("data", (d) => {
        console.warn("[ClearRead] setup stderr:", d.toString().trim());
      });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    });
  }

  private pyHasPiper(py: string): Promise<boolean> {
    return this.runCmd(py, ["-c", "import piper"]);
  }

  // Auto-install piper-tts + download the neural voice (opt-in via setting)
  async ensurePiper(): Promise<boolean> {
    if (this.setupRunning) return false;
    if (this.findPiperModel() && (this.hasBin("piper") || this.discoverPython())) {
      return true;
    }
    this.setupRunning = true;
    try {
      const py = this.discoverPython();
      if (!py) {
        new Notice("ClearRead: Python not found - cannot auto-install the natural voice.");
        return false;
      }
      this.ttsPython = py;

      if (!(await this.pyHasPiper(py))) {
        new Notice("ClearRead: installing Piper neural TTS (first time, 1-2 min)...", 10000);
        const ok =
          (await this.runCmd(py, ["-m", "pip", "install", "--user", "piper-tts"])) ||
          (await this.runCmd(py, ["-m", "pip", "install", "--user", "--break-system-packages", "piper-tts"]));
        if (!ok) {
          new Notice("ClearRead: pip install of piper-tts failed (see console).");
          return false;
        }
      }

      if (!this.findPiperModel()) {
        new Notice(`ClearRead: downloading voice ${PIPER_VOICE} (~60 MB, once)...`, 10000);
        const dir = this.ttsVoiceDir();
        fs.mkdirSync(dir, { recursive: true });
        const ok = await this.runCmd(py, ["-m", "piper.download_voices", PIPER_VOICE], dir);
        if (!ok) {
          new Notice("ClearRead: voice download failed (see console).");
          return false;
        }
      }

      this.binCache.clear();
      new Notice("ClearRead: natural voice ready.");
      return true;
    } finally {
      this.setupRunning = false;
    }
  }

  private findPlayer(): string | null {
    if (this.hasBin("aplay")) return "aplay -q";
    if (this.hasBin("paplay")) return "paplay";
    if (this.hasBin("mpv")) return "mpv -q -";
    return null;
  }

  private resolveModelInCommand(cmd: string): string {
    const m = /-m\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(cmd);
    if (!m) return cmd;
    const arg = m[2] || m[3] || m[4];
    if (!arg || fs.existsSync(arg)) return cmd;
    const found = this.findPiperModel();
    if (!found) return cmd;
    console.log(`[ClearRead] TTS: rewrote model "${arg}" -> ${found}`);
    return cmd.replace(arg, `'${found}'`);
  }

  killTtsChild(): void {
    if (!this.ttsChild) return;
    const pid = this.ttsChild.pid;
    try { this.ttsChild.kill("SIGKILL"); } catch {}
    if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} }
    this.ttsChild = null;
  }

  stopAllTTS(): void {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    this.killTtsChild();
    if (process.platform === "linux" && this.hasBin("spd-say")) {
      try {
        const c = spawn("spd-say", ["-S"], { stdio: "ignore", env: this.ttsEnv() });
        c.on("error", () => {});
        c.unref();
      } catch {}
    }
  }

  private attachTts(child: ChildProcess): void {
    this.ttsChild = child;
    child.stderr?.on("data", (d) => {
      console.warn("[ClearRead] TTS stderr:", d.toString().trim());
    });
    child.on("error", (e) => {
      console.warn("[ClearRead] TTS spawn error:", String(e));
      this.ttsChild = null;
    });
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        console.warn("[ClearRead] TTS exited with code", code);
      }
      this.ttsChild = null;
    });
    child.unref();
  }

  async startSystemTTS(text: string): Promise<boolean> {
    this.killTtsChild();
    const truncated = text.slice(0, 6000);
    const env = this.ttsEnv();
    const custom = (this.settings.ttsCommand || "").trim();

    try {
      if (custom) {
        const isWin = process.platform === "win32";
        const shell = isWin ? "cmd.exe" : "/bin/sh";
        const flag = isWin ? "/c" : "-c";
        const useStdin = !custom.includes("{text}");
        let cmdStr = useStdin ? custom : (() => {
          const esc = isWin
            ? truncated.replace(/"/g, '""')
            : truncated.replace(/'/g, "'\\''");
          return custom.split("{text}").join(isWin ? `"${esc}"` : `'${esc}'`);
        })();

        if (!isWin) {
          cmdStr = this.resolveModelInCommand(cmdStr);
          const m2 = /-m\s+'?([^'\s]+)'?/.exec(cmdStr);
          if (m2 && !fs.existsSync(m2[1])) {
            console.warn("[ClearRead] TTS: custom model unresolved, using built-in chain");
            return await this.startBuiltinTTS(truncated, env);
          }
        }

        console.log("[ClearRead] TTS cmd:", cmdStr);
        const t0 = Date.now();
        const child = spawn(shell, [flag, cmdStr], {
          detached: true,
          stdio: [useStdin ? "pipe" : "ignore", "ignore", "pipe"],
          env,
          cwd: os.homedir()
        });
        if (useStdin) {
          child.stdin?.write(truncated);
          child.stdin?.end();
        }
        child.on("exit", (code) => {
          if (code !== 0 && Date.now() - t0 < 2000) {
            void this.startBuiltinTTS(truncated, env);
          }
        });
        this.attachTts(child);
        return true;
      }
      return await this.startBuiltinTTS(truncated, env);
    } catch (e) {
      console.warn("[ClearRead] system TTS failed", e);
      this.ttsChild = null;
      return false;
    }
  }

  private async startBuiltinTTS(truncated: string, env: NodeJS.ProcessEnv): Promise<boolean> {
    let child: ChildProcess | null = null;

    if (process.platform === "linux" || process.platform === "darwin") {
      // Auto-setup if the user opted in to natural voice
      if (this.settings.ttsEnabled && process.platform === "linux") {
        await this.ensurePiper();
      }

      const model = this.findPiperModel();
      const py = this.ttsPython || this.discoverPython();
      const player = this.findPlayer();

      if (model && player && (py || this.hasBin("piper"))) {
        const runner = py ? `'${py}' -m piper` : "piper";
        const cmdStr = `${runner} -m '${model}' | ${player}`;
        console.log("[ClearRead] TTS cmd (builtin piper):", cmdStr);
        child = spawn("/bin/sh", ["-c", cmdStr], {
          detached: true, stdio: ["pipe", "ignore", "pipe"], env, cwd: os.homedir()
        });
        child.stdin?.write(truncated);
        child.stdin?.end();
      } else if (this.hasBin("spd-say")) {
        child = spawn("spd-say", ["-w", truncated], { detached: true, stdio: "ignore", env });
      } else if (this.hasBin("espeak-ng")) {
        child = spawn("espeak-ng", ["-s", "170", truncated], { detached: true, stdio: "ignore", env });
      } else if (process.platform === "darwin") {
        child = spawn("say", [truncated], { detached: true, stdio: "ignore", env });
      }
    } else if (process.platform === "win32") {
      const ps = `Add-Type -AssemblyName System.speech; ` +
        `(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak(${JSON.stringify(truncated)})`;
      child = spawn("powershell", ["-Command", ps], {
        detached: true, stdio: "ignore", windowsHide: true, env
      });
    }

    if (!child) return false;
    this.attachTts(child);
    return true;
  }

  async waitForVoices(synth: SpeechSynthesis, timeoutMs = 3000): Promise<SpeechSynthesisVoice[]> {
    let voices = synth.getVoices();
    if (voices.length) return voices;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => resolve(synth.getVoices()), timeoutMs);
      const onChange = () => {
        voices = synth.getVoices();
        if (voices.length) {
          window.clearTimeout(timer);
          synth.removeEventListener("voiceschanged", onChange);
          resolve(voices);
        }
      };
      synth.addEventListener("voiceschanged", onChange);
    });
  }

  async testVoice(): Promise<void> {
    const sample = "ClearRead voice test. The quick brown fox jumps over the lazy dog.";
    this.stopAllTTS();
    if ("speechSynthesis" in window) {
      const voices = await this.waitForVoices(window.speechSynthesis);
      if (voices.length) {
        const u = new SpeechSynthesisUtterance(sample);
        u.voice = voices.find((v) => /^en/i.test(v.lang)) || voices[0];
        window.speechSynthesis.speak(u);
        new Notice("Testing Web Speech voice");
        return;
      }
    }
    const ok = await this.startSystemTTS(sample);
    new Notice(ok ? "Testing system TTS" : "No TTS engine found");
  }

  // ---------------- unified bar ----------------

  refreshViews(): void {
    if (!Platform.isDesktop) return;
    for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
      const view: any = leaf.view;
      const container = view?.containerEl as HTMLElement | undefined;
      if (!container) continue;
      this.applyTheme(container);
      container.classList.add("clearread-ruler-host");

      const friendly = this.isFriendlyFile(view.file);
      const existing = container.querySelector(".clearread-bar");
      if (!existing || container.dataset.clearreadMode !== (friendly ? "friendly" : "original")) {
        existing?.remove();
        container.dataset.clearreadMode = friendly ? "friendly" : "original";
        this.buildBar(container, view, friendly);
      }
    }
    this.applyRuler();
  }

  isFriendlyFile(file: TFile | undefined): boolean {
    return !!file && file.path.startsWith(CACHE_DIR + "/");
  }

  buildBar(container: HTMLElement, view: any, friendly: boolean): void {
    const bar = document.createElement("div");
    bar.className = "clearread-bar";

    const addBtn = (text: string, title: string, onclick: () => void) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.title = title;
      b.onclick = onclick;
      bar.appendChild(b);
      return b;
    };

    if (friendly) {
      addBtn("↩", "Open original PDF", () => { void this.openSourceOf(view.file); });
    } else {
      addBtn("♿ ClearRead", "Open dyslexia-friendly cached copy", () => {
        void this.openFriendly(view.file);
      });
    }

    addBtn("Aa", "Choose font (single) & regenerate", () => {
      new FontChooserModal(this.app, this, async (entry) => {
        await this.makePrimary(entry);
        if (friendly) {
          const src = await this.sourceOf(view.file);
          if (src) { void this.openFriendly(src); return; }
          new Notice("Original source not found.");
          return;
        }
        void this.openFriendly(view.file);
      }).open();
    });

    addBtn("🎨", `Theme: ${this.settings.theme} (click to cycle)`, () => this.cycleTheme());
    addBtn("📏", `Ruler: ${this.settings.ruler} (click to cycle)`, () => this.cycleRuler());
    addBtn("🔊", "Read current page aloud", () => { void this.readCurrentPage(container, view); });
    addBtn("⏹", "Stop reading (kills any TTS)", () => { this.stopAllTTS(); });
    addBtn("🗑", "Clear ClearRead cache", () => { void this.clearCache(); });

    container.appendChild(bar);
  }

  cycleTheme(): void {
    const i = THEMES.indexOf(this.settings.theme);
    this.settings.theme = THEMES[(i + 1) % THEMES.length];
    void this.saveData(this.settings);
    this.refreshViews();
    new Notice(`ClearRead theme: ${this.settings.theme}`);
  }

  cycleRuler(): void {
    const i = RULERS.indexOf(this.settings.ruler);
    this.settings.ruler = RULERS[(i + 1) % RULERS.length];
    void this.saveData(this.settings);
    this.refreshViews();
    new Notice(`ClearRead ruler: ${this.settings.ruler}`);
  }

  applyTheme(container: HTMLElement): void {
    for (const t of THEMES) container.classList.remove(`clearread-theme-${t}`);
    if (this.settings.theme !== "none") {
      container.classList.add(`clearread-theme-${this.settings.theme}`);
    }
  }

  applyRuler(): void {
    let overlay = document.querySelector(`.${RULER_OVERLAY_CLASS}`) as HTMLElement | null;

    if (this.settings.ruler === "off") {
      if (overlay) overlay.style.display = "none";
      return;
    }

    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = RULER_OVERLAY_CLASS;
      const band = document.createElement("div");
      band.className = "band";
      overlay.appendChild(band);
      document.body.appendChild(overlay);

      const prev = (window as any).__clearreadRulerMove;
      if (typeof prev === "function") document.removeEventListener("pointermove", prev);

      let pending: PointerEvent | null = null;
      let raf = 0;

      const update = (e: PointerEvent) => {
        const ov = document.querySelector(`.${RULER_OVERLAY_CLASS}`) as HTMLElement | null;
        if (!ov) return;

        if (this.settings.ruler === "off") {
          ov.style.display = "none";
          return;
        }

        let host: HTMLElement | null = null;
        const hosts = Array.from(
          document.querySelectorAll<HTMLElement>(".clearread-ruler-host")
        );
        for (const t of hosts) {
          const r = t.getBoundingClientRect();
          if (e.clientX >= r.left && e.clientX <= r.right &&
              e.clientY >= r.top && e.clientY <= r.bottom) {
            host = t;
            break;
          }
        }
        if (!host) {
          ov.style.display = "none";
          return;
        }
        ov.style.display = "block";
        ov.dataset.mode = this.settings.ruler;
        const rect = host.getBoundingClientRect();
        ov.style.left = `${rect.left}px`;
        ov.style.top = `${rect.top}px`;
        ov.style.width = `${rect.width}px`;
        ov.style.height = `${rect.height}px`;
        const bandEl = ov.querySelector(".band") as HTMLElement | null;
        if (!bandEl) return;
        const y = e.clientY - rect.top - 28;
        const clamped = Math.max(0, Math.min(rect.height - 56, y));
        bandEl.style.transform = `translate3d(0, ${clamped}px, 0)`;
      };

      const moveHandler = (e: PointerEvent) => {
        pending = e;
        if (!raf) {
          raf = requestAnimationFrame(() => {
            raf = 0;
            if (pending) update(pending);
          });
        }
      };

      (window as any).__clearreadRulerMove = moveHandler;
      document.addEventListener("pointermove", moveHandler);
    }

    overlay.style.display = "block";
    overlay.dataset.mode = this.settings.ruler;
  }

  // ---------------- audio ----------------

  currentPageNumber(container: HTMLElement): number {
    const els = Array.from(
      container.querySelectorAll<HTMLElement>("[data-page-number], .page")
    );
    if (!els.length) return 1;
    const cRect = container.getBoundingClientRect();
    let best = 1;
    let bestDist = Infinity;
    els.forEach((el, idx) => {
      const r = el.getBoundingClientRect();
      const d = Math.abs(r.top - cRect.top);
      if (d < bestDist) {
        bestDist = d;
        best = parseInt(el.getAttribute("data-page-number") || String(idx + 1), 10) || idx + 1;
      }
    });
    return best;
  }

  currentPageEl(container: HTMLElement): HTMLElement | null {
    const pages = Array.from(container.querySelectorAll<HTMLElement>(".page"));
    if (!pages.length) return null;
    const cRect = container.getBoundingClientRect();
    let best: HTMLElement | null = null;
    let bestDist = Infinity;
    for (const p of pages) {
      const r = p.getBoundingClientRect();
      const d = Math.abs(r.top - cRect.top);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    return best;
  }

  async ensureTexts(file: TFile): Promise<string[]> {
    const hit = this.infoCache.get(file.path);
    if (hit?.texts?.length) return hit.texts;

    const textsPath = normalizePath(`${CACHE_DIR}/txt-${this.hashKey(file.path)}.json`);
    try {
      const raw = await this.app.vault.adapter.read(textsPath);
      const arr = JSON.parse(raw) as string[];
      if (arr?.length) {
        this.infoCache.set(file.path, { version: CACHE_VERSION, source: file.path, texts: arr });
        return arr;
      }
    } catch {}

    new Notice("ClearRead: extracting text for audio (once per file)...", 4000);
    const data = await this.app.vault.readBinary(file);
    const doc = await PDFDocument.load(data, {
      ignoreEncryption: true,
      updateMetadata: false
    });
    const texts = await extractPageTexts(doc);

    if (!(await this.app.vault.adapter.exists(CACHE_DIR))) {
      await this.app.vault.createFolder(CACHE_DIR);
    }
    await this.app.vault.adapter.write(textsPath, JSON.stringify(texts));
    this.infoCache.set(file.path, { version: CACHE_VERSION, source: file.path, texts });
    return texts;
  }

  async readCurrentPage(container: HTMLElement, view: any): Promise<void> {
    if (!("speechSynthesis" in window)) {
      new Notice("Speech synthesis unavailable in this environment.");
      return;
    }
    const file = view?.file as TFile | undefined;
    if (!file) {
      new Notice("No PDF open in this view.");
      return;
    }
    const pageNum = this.currentPageNumber(container);

    let text = (this.currentPageEl(container)?.querySelector(".textLayer")?.textContent || "")
      .replace(/\s+/g, " ").trim();

    if (!text) {
      try {
        const texts = await this.ensureTexts(file);
        text = texts[pageNum - 1] || "";
        console.log(`[ClearRead] extracted page ${pageNum}: ${text.length} chars`);
      } catch (e) {
        console.warn("[ClearRead] text extraction failed", e);
        new Notice(`ClearRead: text extraction failed - ${String(e)}`);
      }
    }

    if (!text) {
      new Notice("No readable text found on this page.");
      return;
    }

    this.stopAllTTS();
    const synth = window.speechSynthesis;
    const voices = await this.waitForVoices(synth);

    let fallbackFired = false;
    const fireFallback = async () => {
      if (fallbackFired) return;
      fallbackFired = true;
      const ok = await this.startSystemTTS(text);
      if (!ok) {
        new Notice(
          "No TTS engine. Enable 'Natural-voice audio' in ClearRead settings to auto-install Piper."
        );
      }
    };

    if (!voices.length) {
      await fireFallback();
      return;
    }

    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    const voice = voices.find((v) => /^en/i.test(v.lang)) || voices[0];
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }

    let started = false;
    u.onstart = () => { started = true; new Notice(`Reading page ${pageNum}`); };
    u.onerror = (ev) => {
      console.warn("[ClearRead] TTS error", ev.error);
      void fireFallback();
    };
    u.onend = () => {
      if (!started) void fireFallback();
    };

    synth.speak(u);
  }

  // ---------------- source mapping ----------------

  async friendlyInfo(file: TFile | undefined): Promise<CacheInfo | null> {
    if (!file || !this.isFriendlyFile(file)) return null;
    const hit = this.infoCache.get(file.path);
    if (hit) return hit;
    const jsonPath = file.path.replace(/\.pdf$/i, ".json");
    try {
      const raw = await this.app.vault.adapter.read(jsonPath);
      const info = JSON.parse(raw) as CacheInfo;
      this.infoCache.set(file.path, info);
      return info;
    } catch {
      return null;
    }
  }

  async sourceOf(friendlyFile: TFile | undefined): Promise<TFile | null> {
    const info = await this.friendlyInfo(friendlyFile);
    if (info?.source) {
      const t = this.app.vault.getAbstractFileByPath(info.source);
      if (t instanceof TFile) return t;
    }
    return null;
  }

  async openSourceOf(friendlyFile: TFile | undefined): Promise<void> {
    const src = await this.sourceOf(friendlyFile);
    if (src) {
      const leaf = this.app.workspace.getLeaf();
      await leaf.openFile(src);
    } else {
      new Notice("Original source file not found.");
    }
  }

  // ---------------- fonts ----------------

  async makePrimary(entry: FontEntry): Promise<void> {
    this.settings.fontPaths = [entry.path];
    this.parsedFonts.clear();
    await this.saveData(this.settings);
  }

  async addFallback(entry: FontEntry): Promise<void> {
    if (!this.settings.fontPaths.includes(entry.path)) {
      this.settings.fontPaths.push(entry.path);
      this.parsedFonts.clear();
      await this.saveData(this.settings);
    }
  }

  pluginDir(): string {
    return `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  async scanVaultFonts(): Promise<FontEntry[]> {
    const out: FontEntry[] = [];
    try {
      const { files } = await this.app.vault.adapter.list(this.pluginDir());
      files.filter((f) => f.endsWith(".ttf")).sort()
        .forEach((f) => out.push({
          name: f.split("/").pop()!.replace(/\.ttf$/i, ""),
          path: f, system: false
        }));
    } catch {}
    return out;
  }

  scanSystemFonts(): FontEntry[] {
    if (!Platform.isDesktop) return [];
    const home = os.homedir();
    const dirs: string[] = [];
    if (process.platform === "win32") {
      dirs.push(path.join(process.env.WINDIR || "C:\\Windows", "Fonts"));
    } else if (process.platform === "darwin") {
      dirs.push("/System/Library/Fonts", "/Library/Fonts", path.join(home, "Library/Fonts"));
    } else {
      dirs.push("/usr/share/fonts", "/usr/local/share/fonts",
        path.join(home, ".fonts"), path.join(home, ".local/share/fonts"));
    }
    const out: FontEntry[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 3 || out.length > 1000) return;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (/\.ttf$/i.test(e.name)) {
          out.push({ name: e.name.replace(/\.ttf$/i, ""), path: full, system: true });
        }
      }
    };
    dirs.forEach((d) => walk(d, 0));
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async readFontBytes(entry: FontEntry): Promise<Uint8Array> {
    if (entry.system) return new Uint8Array(fs.readFileSync(entry.path));
    return new Uint8Array(await this.app.vault.adapter.readBinary(entry.path));
  }

  async resolveEntries(): Promise<FontEntry[]> {
    const vault = await this.scanVaultFonts();
    return [...vault, ...this.systemFonts];
  }

  async loadSubstitutes(): Promise<{ fonts: TTFont[]; entry: FontEntry; label: string }> {
    const entries = await this.resolveEntries();
    const chosen = this.settings.fontPaths
      .map((p) => entries.find((e) => e.path === p))
      .filter((e): e is FontEntry => !!e);
    if (!chosen.length) {
      const first = entries[0];
      if (!first) {
        throw new Error("No substitute .ttf found. Download one in ClearRead settings or scan system fonts.");
      }
      chosen.push(first);
    }
    const fonts: TTFont[] = [];
    for (const e of chosen.slice(0, 4)) {
      let f = this.parsedFonts.get(e.path);
      if (!f) {
        const bytes = await this.readFontBytes(e);
        f = parseTTF(bytes, true);
        if (!f.numGlyphs) throw new Error(`${e.name}: no glyphs`);
        this.parsedFonts.set(e.path, f);
      }
      fonts.push(f);
    }
    const label =
      chosen[0].name +
      (chosen.length > 1 ? ` (+${chosen.length - 1} fallback${chosen.length > 2 ? "s" : ""})` : "");
    return { fonts, entry: chosen[0], label };
  }

  async downloadFont(fileName: string): Promise<void> {
    const url = FONT_PRESETS[fileName];
    if (!url) throw new Error(`Unknown preset ${fileName}`);
    new Notice(`ClearRead: downloading ${fileName}...`);
    const res = await requestUrl({ url });
    if (res.status !== 200) throw new Error(`${fileName}: HTTP ${res.status}`);
    await this.app.vault.adapter.writeBinary(
      `${this.pluginDir()}/${fileName}`, await res.arrayBuffer()
    );
    this.parsedFonts.clear();
    new Notice(`ClearRead: ${fileName} installed.`);
  }

  // ---------------- fast hash cache ----------------

  hashKey(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  async openFriendly(file?: TFile): Promise<void> {
    const target = file ?? this.app.workspace.getActiveFile();
    if (!target || target.extension !== "pdf") {
      new Notice("Open a PDF first.");
      return;
    }
    try {
      const { fonts, label } = await this.loadSubstitutes();

      const key = this.hashKey(
        `${CACHE_VERSION}|${target.path}|${target.stat.size}|${target.stat.mtime}|` +
        this.settings.fontPaths.join(",")
      );
      const cachePath = normalizePath(`${CACHE_DIR}/${key}.pdf`);
      const jsonPath = `${CACHE_DIR}/${key}.json`;

      let cached = this.app.vault.getAbstractFileByPath(cachePath) as TFile | null;

      if (!cached) {
        const notice = new Notice(`ClearRead: transforming with ${label}...`, 0);
        try {
          const input = new Uint8Array(await this.app.vault.readBinary(target));
          const { bytes, stats } = await transformPdf(input, fonts, (m) => {
            notice.setMessage(`ClearRead: ${m}`);
          });
          notice.hide();
          new Notice(
            `ClearRead: ${label} on ${stats.fontsSwapped}/${stats.fontsSeen} fonts` +
            (stats.skipped.length ? `; ${stats.skipped.length} kept original (math/symbol)` : "")
          );
          if (stats.skipped.length) console.log("[ClearRead] kept original:", stats.skipped);

          if (!(await this.app.vault.adapter.exists(CACHE_DIR))) {
            await this.app.vault.createFolder(CACHE_DIR);
          }
          const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          cached = await this.app.vault.createBinary(cachePath, buf as ArrayBuffer);
          const info: CacheInfo = { version: CACHE_VERSION, source: target.path, texts: [] };
          await this.app.vault.adapter.write(jsonPath, JSON.stringify(info));
          this.infoCache.set(cachePath, info);
        } catch (e) {
          notice.hide();
          throw e;
        }
      }

      if (cached) {
        const leaf = this.app.workspace.getLeaf();
        await leaf.openFile(cached);
      }
    } catch (e) {
      console.error("[ClearRead]", e);
      new Notice(`ClearRead: ${String(e)}`);
    }
  }

  async clearCache(): Promise<void> {
    this.infoCache.clear();
    const dir = this.app.vault.getAbstractFileByPath(CACHE_DIR);
    if (dir) {
      await this.app.vault.delete(dir, true);
      new Notice("ClearRead cache cleared. Next open re-transforms the PDF.");
    } else {
      new Notice("ClearRead cache already empty.");
    }
  }
}

export class FontChooserModal extends Modal {
  constructor(
    app: App,
    private plugin: ClearReadPlugin,
    private onPick: (entry: FontEntry) => void
  ) { super(app); }

  async onOpen(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.createEl("h2", { text: "Choose substitute font" });

    const search = document.createElement("input");
    search.type = "text";
    search.placeholder = "Search vault + system fonts...";
    search.className = "clearread-search";
    el.appendChild(search);

    const list = document.createElement("div");
    list.className = "clearread-list";
    el.appendChild(list);

    if (!this.plugin.systemFonts.length) {
      this.plugin.systemFonts = this.plugin.scanSystemFonts();
    }
    const entries = await this.plugin.resolveEntries();

    const render = (q: string) => {
      list.innerHTML = "";
      const ql = q.trim().toLowerCase();
      const shown = entries
        .filter((e) => !ql || e.name.toLowerCase().includes(ql))
        .slice(0, 400);
      for (const e of shown) {
        const row = document.createElement("div");
        row.className = "clearread-row";
        row.textContent = `${e.name}  [${e.system ? "system" : "vault"}]`;
        row.onclick = () => { this.onPick(e); this.close(); };
        list.appendChild(row);
      }
    };
    search.oninput = () => render(search.value);
    render("");
  }
}

class ClearReadSettingTab extends PluginSettingTab {
  plugin: ClearReadPlugin;
  constructor(app: App, plugin: ClearReadPlugin) { super(app, plugin); this.plugin = plugin; }

  async display(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "ClearRead PDF" });
    containerEl.createEl("p", {
      text: "Font-data substitution inside a cached copy. Native viewer, search, copy and images preserved. Math/symbol fonts automatically kept original."
    });

    new Setting(containerEl)
      .setName("Natural-voice audio (Piper)")
      .setDesc(
        "On first use, automatically installs piper-tts via pip and downloads a neural voice " +
        "into ~/.clearread-tts. Nothing is installed unless you enable this."
      )
      .addToggle((t) => t
        .setValue(this.plugin.settings.ttsEnabled)
        .onChange(async (v) => {
          this.plugin.settings.ttsEnabled = v;
          await this.plugin.saveData(this.plugin.settings);
          if (v) void this.plugin.ensurePiper();
        }));

    new Setting(containerEl)
      .setName("Auto-friendly mode")
      .setDesc("Opening any PDF opens the accessible copy instead (transformed once, cached).")
      .addToggle((t) => t
        .setValue(this.plugin.settings.autoFriendly)
        .onChange(async (v) => {
          this.plugin.settings.autoFriendly = v;
          await this.plugin.saveData(this.plugin.settings);
        }));

    new Setting(containerEl)
      .setName("Reading theme")
      .addDropdown((d) => {
        THEMES.forEach((t) => d.addOption(t, t));
        d.setValue(this.plugin.settings.theme);
        d.onChange(async (v) => {
          this.plugin.settings.theme = v as Theme;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.refreshViews();
        });
      });

    new Setting(containerEl)
      .setName("Reading ruler")
      .addDropdown((d) => {
        RULERS.forEach((r) => d.addOption(r, r));
        d.setValue(this.plugin.settings.ruler);
        d.onChange(async (v) => {
          this.plugin.settings.ruler = v as RulerMode;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.refreshViews();
        });
      });

    new Setting(containerEl)
      .setName("Custom TTS command (optional)")
      .setDesc(
        "Leave empty to auto-use piper → speech-dispatcher → espeak-ng. " +
        "Text is piped via stdin unless {text} is present."
      )
      .addText((t) => t
        .setPlaceholder("piper -m <model>.onnx | aplay -q")
        .setValue(this.plugin.settings.ttsCommand)
        .onChange(async (v) => {
          this.plugin.settings.ttsCommand = v;
          await this.plugin.saveData(this.plugin.settings);
        }));

    new Setting(containerEl)
      .setName("Test voice")
      .setDesc("Audition the current TTS engine.")
      .addButton((b) => b.setButtonText("Test").onClick(() => { void this.plugin.testVoice(); }));

    const dl = new Setting(containerEl)
      .setName("Download fonts")
      .setDesc("One-time downloads, stored locally in the plugin folder.");
    for (const name of Object.keys(FONT_PRESETS)) {
      dl.addButton((b) => b
        .setButtonText(name.replace(/-Regular\.ttf$/, "").replace(/\.ttf$/, ""))
        .onClick(async () => {
          try { await this.plugin.downloadFont(name); await this.display(); }
          catch (e) { new Notice(`ClearRead: ${String(e)}`); }
        }));
    }

    const preview = containerEl.createDiv();
    preview.style.cssText =
      "font-size:24px;margin:10px 0;padding:10px;border:1px solid var(--background-modifier-border);border-radius:8px;";
    preview.textContent = "The quick brown fox ∑∫ 0123";

    new Setting(containerEl)
      .setName("Font chain")
      .setDesc(
        "Primary font first; optional fallbacks for missing glyphs (e.g. a symbol font for ∴ ∑ ). " +
        "Picking a font with Aa always sets a single primary."
      );

    this.plugin.settings.fontPaths.forEach((p, i) => {
      new Setting(containerEl)
        .setName(i === 0 ? "Primary" : `Fallback ${i}`)
        .setDesc(p)
        .addButton((b) => b.setButtonText("✕").onClick(async () => {
          this.plugin.settings.fontPaths.splice(i, 1);
          this.plugin.parsedFonts.clear();
          await this.plugin.saveData(this.plugin.settings);
          await this.display();
        }));
    });

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add fallback font...").setCta().onClick(() => {
        new FontChooserModal(this.app, this.plugin, async (entry) => {
          await this.plugin.addFallback(entry);
          await this.display();
        }).open();
      }));

    const entries = await this.plugin.resolveEntries();
    const current = entries.find((e) => e.path === this.plugin.settings.fontPaths[0]) ?? entries[0];
    if (current) {
      new Setting(containerEl).setName("Current primary").setDesc(current.path);
      await this.preview(current, preview);
    }

    new Setting(containerEl)
      .setName("Clear cache")
      .addButton((b) => b.setButtonText("Clear cache").onClick(async () => {
        await this.plugin.clearCache();
      }));
  }

  async preview(entry: FontEntry, el: HTMLElement): Promise<void> {
    try {
      const bytes = await this.plugin.readFontBytes(entry);
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const face = new FontFace("clearread-preview", buf as ArrayBuffer);
      await face.load();
      document.fonts.add(face);
      el.style.fontFamily = "clearread-preview";
    } catch (e) {
      console.warn("[ClearRead] preview failed", e);
    }
  }
}
