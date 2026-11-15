import crypto from "crypto";

import logger from "./logger.ts";
import { getSetting, setSetting } from "./database.ts";

/**
 * 浏览器传输层
 *
 * 即梦对 Seedance 2.0 pro / fast 等部分链路启用了风控中间件（starling），
 * 要求请求携带浏览器端 SDK 生成的 msToken 与 a_bogus 签名，纯服务端请求
 * 会被拒绝（HTTP 200 + ret=4013）。本模块把请求交给真实浏览器页面执行，
 * 由即梦页面自身的 SDK 完成签名，并把浏览器环境下的设备 cookie 一并带上。
 *
 * 该能力依赖 playwright-core 与本机 Chrome/Edge，默认 auto：只在遇到风控拦截时
 * 才启用，未触发风控的请求不受影响。可通过控制台「系统设置」或环境变量调整：
 *   JIMENG_BROWSER_TRANSPORT=off      # 关闭
 *   JIMENG_BROWSER_TRANSPORT=auto     # 仅在上游风控拦截时改用浏览器重试（默认）
 *   JIMENG_BROWSER_TRANSPORT=always   # 所有请求都走浏览器
 */
export type BrowserTransportMode = "off" | "auto" | "always";

/** 传输模式来源 */
export type BrowserTransportModeSource = "console" | "env" | "default";

/** 控制台设置项：浏览器传输模式（优先于环境变量） */
export const BROWSER_TRANSPORT_SETTING_KEY = "browser_transport_mode";

/** 默认传输模式 */
export const DEFAULT_BROWSER_TRANSPORT_MODE: BrowserTransportMode = "auto";

/** 支持的模式取值 */
const BROWSER_TRANSPORT_MODES: BrowserTransportMode[] = ["off", "auto", "always"];

/**
 * 浏览器传输请求参数
 */
export interface BrowserRequestOptions {
  /** 请求方法 */
  method: string;
  /** 完整请求地址 */
  url: string;
  /** 查询参数 */
  params: Record<string, any>;
  /** 请求头（Cookie 由浏览器自行携带，无需传入） */
  headers: Record<string, any>;
  /** 请求体 */
  data?: any;
  /** 账号 cookie（name/value 对） */
  cookiePairs: Array<[string, string]>;
}

/**
 * 浏览器传输响应（结构对齐 AxiosResponse）
 */
export interface BrowserResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: any;
  config: any;
}

/** 页面初始化后等待应用脚本装载的时间 */
const APP_READY_DELAY = 6000;
/** 视口尺寸 */
const VIEWPORT = { width: 1440, height: 900 };

/**
 * 页面内执行的请求函数（会被序列化后注入浏览器，不能引用外部作用域）
 */
const inPageRequest = async (payload: {
  url: string;
  method: string;
  params: Record<string, any>;
  headers: Record<string, any>;
  data: any;
  timeout: number;
}) => {
  const target = new URL(payload.url);
  for (const [key, value] of Object.entries(payload.params || {})) {
    if (value === undefined || value === null) continue;
    target.searchParams.set(key, String(value));
  }
  const hasBody = payload.method !== "GET" && payload.method !== "HEAD";
  const body = !hasBody
    ? undefined
    : typeof payload.data === "string"
      ? payload.data
      : JSON.stringify(payload.data ?? {});
  // 浏览器禁止脚本设置 Cookie/Origin/Referer 等头，过滤掉由浏览器自行补齐
  const blocked = ["cookie", "origin", "referer", "host", "content-length", "accept-encoding", "connection"];
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload.headers || {})) {
    if (blocked.includes(key.toLowerCase())) continue;
    if (value === undefined || value === null) continue;
    headers[key] = String(value);
  }
  if (body && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type"))
    headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), payload.timeout);
  try {
    // 页面自身的 fetch 包装器会按需补上 msToken / a_bogus 等签名参数
    const response = await fetch(target.toString(), {
      method: payload.method,
      headers,
      body,
      credentials: "include",
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, statusText: response.statusText, text };
  } catch (error: any) {
    return { status: 0, statusText: "", text: "", error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
};

class BrowserTransport {

  /** 当前传输模式（可在控制台运行时修改） */
  private currentMode: BrowserTransportMode = DEFAULT_BROWSER_TRANSPORT_MODE;
  /** 当前模式的来源 */
  private modeSource: BrowserTransportModeSource = "default";
  /** playwright-core 可用性（惰性检测后缓存） */
  private dependencyAvailable: boolean | null = null;
  /** 是否无头模式 */
  private readonly headless: boolean;
  /** 浏览器通道 */
  private readonly channel?: string;
  /** 浏览器可执行文件路径 */
  private readonly executablePath?: string;
  /** 用于装载签名的页面地址 */
  private readonly pageUrl: string;
  /** 请求超时（毫秒） */
  private readonly requestTimeout: number;
  /** 导航超时（毫秒） */
  private readonly navigationTimeout: number;
  /** 空闲关闭时间（毫秒） */
  private readonly idleTimeout: number;
  /** 伪装 UA，避免页面识别出 Headless 环境 */
  private readonly userAgent: string;
  /** 额外的浏览器启动参数 */
  private readonly launchArgs: string[];

  /** 浏览器实例（所有账号共享进程） */
  private browser: any = null;
  /** 正在启动中的 Promise，避免并发重复启动 */
  private launching: Promise<void> | null = null;
  /**
   * 每个账号一个独立上下文：设备 cookie / 签名 SDK 状态互相隔离，避免多账号被关联；
   * 同一账号内串行，不同账号之间并行
   */
  private readonly sessions = new Map<string, BrowserSession>();
  /** 同时保留的账号上下文上限（每个上下文都会装载一个即梦页面，较占内存） */
  private readonly maxContexts: number;
  /** 扫码登录等独立上下文数量（存在时不因空闲关闭浏览器） */
  private isolatedContexts = 0;
  /** 已知需要浏览器签名的请求标识 */
  private readonly browserRequiredKeys = new Set<string>();

  constructor() {
    const env = process.env;
    this.headless = String(env.JIMENG_BROWSER_HEADLESS || "true").toLowerCase() !== "false";
    this.channel = env.JIMENG_BROWSER_CHANNEL || undefined;
    this.executablePath = env.JIMENG_BROWSER_EXECUTABLE || undefined;
    this.pageUrl = env.JIMENG_BROWSER_PAGE_URL || "https://jimeng.jianying.com/ai-tool/video/generate";
    this.requestTimeout = Number(env.JIMENG_BROWSER_REQUEST_TIMEOUT || 60000);
    this.navigationTimeout = Number(env.JIMENG_BROWSER_NAVIGATION_TIMEOUT || 90000);
    this.idleTimeout = Number(env.JIMENG_BROWSER_IDLE_TIMEOUT || 300000);
    this.maxContexts = Math.max(1, Number(env.JIMENG_BROWSER_MAX_CONTEXTS) || 4);
    this.userAgent =
      env.JIMENG_BROWSER_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
    this.launchArgs = String(env.JIMENG_BROWSER_ARGS || "")
      .split(",")
      .map(item => item.trim())
      .filter(Boolean);
    this.applyInitialMode();
  }

  /** 当前传输模式 */
  get mode() {
    return this.currentMode;
  }

  /** 传输层是否启用 */
  get enabled() {
    return this.currentMode !== "off";
  }

  /**
   * 规范化模式取值
   *
   * @param value 待校验的值
   */
  private normalizeMode(value: any): BrowserTransportMode | null {
    const mode = String(value ?? "").trim().toLowerCase();
    return BROWSER_TRANSPORT_MODES.includes(mode as BrowserTransportMode)
      ? (mode as BrowserTransportMode)
      : null;
  }

  /**
   * 初始化传输模式
   *
   * 优先级：控制台设置 > 环境变量 > 默认值
   */
  private applyInitialMode() {
    let persisted: string | null = null;
    try {
      persisted = getSetting(BROWSER_TRANSPORT_SETTING_KEY);
    } catch (error: any) {
      logger.warn(`读取浏览器传输设置失败，回退到环境变量: ${error?.message || error}`);
    }
    const fromConsole = this.normalizeMode(persisted);
    if (fromConsole) {
      this.currentMode = fromConsole;
      this.modeSource = "console";
      return;
    }
    const fromEnv = this.normalizeMode(process.env.JIMENG_BROWSER_TRANSPORT);
    if (fromEnv) {
      this.currentMode = fromEnv;
      this.modeSource = "env";
      return;
    }
    this.currentMode = DEFAULT_BROWSER_TRANSPORT_MODE;
    this.modeSource = "default";
  }

  /**
   * 修改传输模式（控制台调用）
   *
   * @param mode 目标模式
   * @param persist 是否持久化到数据库
   */
  async setMode(mode: BrowserTransportMode, persist: boolean = true) {
    const next = this.normalizeMode(mode);
    if (!next) throw new Error(`[浏览器传输] 无效模式: ${mode}`);
    if (persist) setSetting(BROWSER_TRANSPORT_SETTING_KEY, next);
    this.currentMode = next;
    this.modeSource = persist ? "console" : "env";
    logger.info(`浏览器传输模式已切换为 ${next}（来源: ${this.modeSource}）`);
    if (next === "off") {
      this.browserRequiredKeys.clear();
      await this.close();
    }
  }

  /**
   * 检测 playwright-core 是否可用（结果缓存）
   */
  async isDependencyAvailable() {
    if (this.dependencyAvailable !== null) return this.dependencyAvailable;
    try {
      await import("playwright-core");
      this.dependencyAvailable = true;
    } catch {
      this.dependencyAvailable = false;
    }
    return this.dependencyAvailable;
  }

  /**
   * 获取传输层状态（供控制台展示）
   */
  async getStatus() {
    return {
      mode: this.currentMode,
      modeSource: this.modeSource,
      defaultMode: DEFAULT_BROWSER_TRANSPORT_MODE,
      envMode: this.normalizeMode(process.env.JIMENG_BROWSER_TRANSPORT),
      dependencyAvailable: await this.isDependencyAvailable(),
      browserRunning: Boolean(this.browser),
      contexts: this.sessions.size,
      maxContexts: this.maxContexts,
      markedKeys: Array.from(this.browserRequiredKeys),
    };
  }

  /**
   * 判断某个请求是否应该走浏览器
   *
   * @param key 请求标识（接口路径 + 上游模型，见 core.ts 的 getRiskControlKey）
   */
  shouldUse(key: string) {
    if (!this.enabled) return false;
    return this.mode === "always" || this.browserRequiredKeys.has(key);
  }

  /**
   * 标记某个请求需要浏览器签名
   *
   * @param key 请求标识（接口路径 + 上游模型）
   */
  markRequired(key: string) {
    if (this.browserRequiredKeys.has(key)) return;
    this.browserRequiredKeys.add(key);
    logger.info(`模型链路 ${key} 已标记为需要浏览器签名，后续请求将直接使用浏览器传输`);
  }

  /**
   * 通过浏览器发送请求
   *
   * @param options 请求参数
   */
  async request(options: BrowserRequestOptions): Promise<BrowserResponse> {
    const key = sessionKey(options.cookiePairs);
    let session = this.sessions.get(key);
    if (!session) {
      session = { key, context: null, page: null, ready: null, queue: Promise.resolve(), pending: 0, lastUsed: Date.now(), idleTimer: null };
      this.sessions.set(key, session);
    }
    const target = session;
    target.pending++;
    // 同一账号串行（共用一个页面），不同账号各自独立并行
    const task = target.queue.then(
      () => this.execute(target, options),
      () => this.execute(target, options)
    );
    target.queue = task.catch(() => undefined).finally(() => {
      target.pending--;
      this.touch(target);
    });
    return task;
  }

  /**
   * 创建不参与请求调度的独立上下文（扫码登录用），复用同一浏览器与启动配置；用完调用 context.close()
   */
  async newIsolatedContext() {
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      userAgent: this.userAgent,
      viewport: VIEWPORT,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });
    this.isolatedContexts++;
    context.on("close", () => {
      this.isolatedContexts--;
      if (!this.isolatedContexts && !this.sessions.size) this.close();
    });
    return context;
  }

  /** 关闭浏览器及所有账号上下文 */
  async close() {
    for (const session of this.sessions.values()) {
      if (session.idleTimer) clearTimeout(session.idleTimer);
    }
    this.sessions.clear();
    const browser = this.browser;
    this.browser = null;
    if (!browser) return;
    try {
      await browser.close();
      logger.info("浏览器传输层已关闭");
    } catch (error: any) {
      logger.warn(`关闭浏览器失败: ${error?.message || error}`);
    }
  }

  /**
   * 执行请求
   */
  private async execute(session: BrowserSession, options: BrowserRequestOptions): Promise<BrowserResponse> {
    session.lastUsed = Date.now();
    const payload = {
      url: options.url,
      method: options.method.toUpperCase(),
      params: options.params || {},
      headers: options.headers || {},
      data: options.data ?? null,
      timeout: this.requestTimeout,
    };

    logger.info(`[浏览器传输] ${payload.method} ${options.url}`);
    let page = await this.ensureSessionPage(session, options.cookiePairs);
    let result = await page.evaluate(inPageRequest, payload).catch((error: any) => ({
      status: 0, statusText: "", text: "", error: String(error?.message || error),
    }));

    // 页面或上下文异常时重建该账号的上下文重试一次
    if (result.status === 0 && result.error) {
      logger.warn(`[浏览器传输] 请求失败，重建账号上下文后重试: ${result.error}`);
      await this.closeSession(session);
      page = await this.ensureSessionPage(session, options.cookiePairs);
      result = await page.evaluate(inPageRequest, payload);
    }

    if (result.status === 0)
      throw new Error(`[浏览器传输] 请求失败: ${result.error || "未知错误"}`);

    let data: any = result.text;
    try {
      data = JSON.parse(result.text);
    } catch {
      // 非 JSON 响应保持原文
    }
    return {
      status: result.status,
      statusText: result.statusText,
      headers: {},
      data,
      config: {},
    };
  }

  /**
   * 确保浏览器已启动
   */
  private async ensureBrowser() {
    if (this.browser) return this.browser;
    if (!this.launching) {
      this.launching = this.launchBrowser().finally(() => (this.launching = null));
    }
    await this.launching;
    if (!this.browser) throw new Error("[浏览器传输] 浏览器不可用");
    return this.browser;
  }

  /**
   * 确保账号上下文与页面可用（首次使用时创建并装载即梦页面）
   */
  private async ensureSessionPage(session: BrowserSession, cookiePairs: Array<[string, string]>) {
    if (session.page && !session.page.isClosed()) return session.page;
    if (!session.ready) {
      session.ready = this.openSession(session, cookiePairs).catch((error) => {
        session.ready = null;
        throw error;
      });
    }
    await session.ready;
    if (!session.page) throw new Error("[浏览器传输] 浏览器页面不可用");
    return session.page;
  }

  /**
   * 为账号创建独立上下文：先写入账号 cookie 再打开页面，签名 SDK 以该账号身份初始化
   */
  private async openSession(session: BrowserSession, cookiePairs: Array<[string, string]>) {
    await this.evictIdleSessions(session);
    const browser = await this.ensureBrowser();
    session.context = await browser.newContext({
      userAgent: this.userAgent,
      viewport: VIEWPORT,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });
    if (cookiePairs?.length) {
      await session.context.addCookies(
        cookiePairs.map(([name, value]) => ({ name, value, domain: ".jianying.com", path: "/" }))
      );
    }
    session.page = await session.context.newPage();
    session.page.on("close", () => {
      session.page = null;
    });

    await session.page.goto(this.pageUrl, { waitUntil: "domcontentloaded", timeout: this.navigationTimeout });
    await session.page.waitForTimeout(APP_READY_DELAY);

    const ready = await session.page
      .evaluate(() => ({
        href: location.href,
        hasBdms: typeof (window as any).bdms !== "undefined",
      }))
      .catch(() => ({ href: "", hasBdms: false }));
    if (!ready.hasBdms)
      logger.warn("[浏览器传输] 页面未检测到签名 SDK，若请求仍被风控拦截请检查页面地址或登录状态");
    logger.info(`浏览器传输层账号上下文就绪（${this.sessions.size}/${this.maxContexts}）: ${ready.href}`);
  }

  /**
   * 启动浏览器
   */
  private async launchBrowser() {
    let playwright: any;
    try {
      playwright = await import("playwright-core");
    } catch {
      throw new Error("[浏览器传输] 缺少依赖 playwright-core，请先执行 npm i playwright-core");
    }

    const launchOptions: any = {
      headless: this.headless,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        ...this.launchArgs,
      ],
    };
    if (this.executablePath) launchOptions.executablePath = this.executablePath;
    else if (this.channel) launchOptions.channel = this.channel;

    logger.info(`浏览器传输层启动中（headless=${this.headless}, channel=${this.channel || "自动"}）...`);
    try {
      this.browser = await playwright.chromium.launch(launchOptions);
    } catch (error: any) {
      if (this.channel || this.executablePath) throw error;
      // 未指定通道时，依次尝试本机 Chrome / Edge
      logger.warn(`默认通道启动失败（${error?.message || error}），尝试使用本机 Edge`);
      this.browser = await playwright.chromium.launch({ ...launchOptions, channel: "msedge" });
    }
    this.browser.on?.("disconnected", () => {
      this.browser = null;
      // 浏览器崩溃：保留会话对象，下次请求时在新浏览器里重建上下文
      for (const session of this.sessions.values()) {
        session.context = null;
        session.page = null;
        session.ready = null;
      }
    });
  }

  /**
   * 上下文数量达到上限时，关闭最久未用且空闲的账号上下文
   */
  private async evictIdleSessions(except: BrowserSession) {
    const open = () => [...this.sessions.values()].filter((s) => s !== except && s.context);
    while (open().length >= this.maxContexts) {
      const victim = open()
        .filter((s) => s.pending === 0)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      // 全部在忙：允许临时超出上限，避免请求卡死
      if (!victim) return;
      await this.closeSession(victim);
      this.sessions.delete(victim.key);
    }
  }

  /** 关闭某个账号的上下文（保留会话对象，下次请求时重建） */
  private async closeSession(session: BrowserSession) {
    const context = session.context;
    session.context = null;
    session.page = null;
    session.ready = null;
    if (!context) return;
    try {
      await context.close();
    } catch (error: any) {
      logger.warn(`关闭账号上下文失败: ${error?.message || error}`);
    }
  }

  /**
   * 刷新账号上下文的空闲关闭定时器；所有上下文都关闭后关闭浏览器
   */
  private touch(session: BrowserSession) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (!this.idleTimeout) return;
    session.idleTimer = setTimeout(async () => {
      if (session.pending > 0) return this.touch(session);
      await this.closeSession(session);
      this.sessions.delete(session.key);
      if (!this.sessions.size && !this.isolatedContexts && this.browser) {
        logger.info(`浏览器传输层空闲超过 ${Math.round(this.idleTimeout / 1000)} 秒，自动关闭`);
        await this.close();
      }
    }, this.idleTimeout);
    session.idleTimer.unref?.();
  }

}

/** 浏览器内某个账号的独立会话 */
interface BrowserSession {
  key: string;
  context: any;
  page: any;
  ready: Promise<void> | null;
  queue: Promise<any>;
  /** 排队及执行中的请求数 */
  pending: number;
  lastUsed: number;
  idleTimer: NodeJS.Timeout | null;
}

/** 按账号 sessionid 区分上下文（取哈希，避免凭据出现在日志或内存键中） */
function sessionKey(cookiePairs: Array<[string, string]>): string {
  const sessionId = cookiePairs?.find(([name]) => name === "sessionid")?.[1] || "";
  return crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

export default new BrowserTransport();
