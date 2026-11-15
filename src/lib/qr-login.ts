import crypto from "crypto";

import accountPool, { type AccountProvider, type PublicAccount } from "./account-pool.ts";
import browserTransport from "./browser-transport.ts";
import logger from "./logger.ts";

/**
 * 扫码登录（远程登录视图）
 *
 * 服务端用浏览器打开官方登录页，控制台实时显示截图并转发点击/输入，
 * 用户用手机扫码（或完成页面上的任何登录步骤），检测到本站 sessionid 后
 * 自动把整站 Cookie 加密存入账号池。不依赖页面 DOM 结构，官网改版或弹窗变化不影响。
 */

const LOGIN_PAGES: Record<AccountProvider, { url: string; cookieDomain: string; label: string }> = {
  jimeng: { url: "https://jimeng.jianying.com/ai-tool/home", cookieDomain: "jianying.com", label: "即梦" },
  doubao: { url: "https://www.doubao.com/chat/", cookieDomain: "doubao.com", label: "豆包" },
};
const SESSION_TTL_MS = 5 * 60_000;
const COOKIE_POLL_MS = 1500;
const MAX_SESSIONS = 3;

export type QrLoginStatus = "waiting" | "success" | "expired" | "error";

interface QrLoginSession {
  id: string;
  provider: AccountProvider;
  name?: string;
  accountId?: string;
  context: any;
  /** 当前显示的页面（登录弹出的新窗口，例如抖音授权页，会自动切换过去） */
  page: any;
  status: QrLoginStatus;
  error?: string;
  account?: PublicAccount;
  expiresAt: number;
  timers: NodeJS.Timeout[];
}

const sessions = new Map<string, QrLoginSession>();

export function hasSessionCookie(cookies: Array<{ name: string; value: string; domain: string }>, cookieDomain: string) {
  return cookies.some((c) => c.name === "sessionid" && c.value && c.domain.replace(/^\./, "").endsWith(cookieDomain));
}

/** 只取本站 Cookie（登录弹窗可能带来 douyin.com 等第三方站点的同名 sessionid） */
export function siteCookieHeader(cookies: Array<{ name: string; value: string; domain: string }>, cookieDomain: string) {
  return cookies
    .filter((c) => c.domain.replace(/^\./, "").endsWith(cookieDomain))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

export async function startQrLogin(input: { provider: AccountProvider; name?: string; accountId?: string }) {
  const site = LOGIN_PAGES[input.provider];
  if (!site) throw new Error("不支持的平台");
  if (input.accountId && accountPool.get(input.accountId).provider !== input.provider)
    throw new Error("账号平台与扫码平台不一致");
  if (sessions.size >= MAX_SESSIONS) throw new Error("同时进行的扫码登录过多，请先完成或取消其他登录");

  const context = await browserTransport.newIsolatedContext();
  const session: QrLoginSession = {
    id: crypto.randomBytes(12).toString("hex"),
    provider: input.provider,
    name: input.name?.trim() || undefined,
    accountId: input.accountId || undefined,
    context,
    page: await context.newPage(),
    status: "waiting",
    expiresAt: Date.now() + SESSION_TTL_MS,
    timers: [],
  };
  sessions.set(session.id, session);
  context.on("page", (page: any) => {
    session.page = page;
    page.on("close", () => {
      if (session.page === page) session.page = context.pages().at(-1) || null;
    });
  });

  try {
    await session.page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (error: any) {
    await finish(session, "error", `打开${site.label}登录页失败: ${error?.message || error}`);
    throw new Error(session.error);
  }
  // 尽量自动关掉活动弹窗并点开登录框；失败无妨，用户可以在画面里自己点
  session.page.waitForTimeout(3000)
    .then(() => session.page?.keyboard.press("Escape"))
    .then(() => session.page?.waitForTimeout(800))
    .then(() => session.page?.getByText(/^登录$/).first().click({ timeout: 5000 }))
    .catch(() => undefined);

  session.timers.push(setInterval(() => checkLoggedIn(session).catch(() => undefined), COOKIE_POLL_MS));
  session.timers.push(setTimeout(() => finish(session, "expired", "扫码超时，请重新发起"), SESSION_TTL_MS));
  logger.info(`扫码登录已启动（${site.label}）: ${session.id}`);
  return publicSession(session);
}

async function checkLoggedIn(session: QrLoginSession) {
  if (session.status !== "waiting") return;
  const site = LOGIN_PAGES[session.provider];
  const cookies = await session.context.cookies();
  if (!hasSessionCookie(cookies, site.cookieDomain)) return;
  // 再等一会儿让页面写完 ttwid / msToken 等配套 Cookie（豆包请求需要）
  session.status = "success";
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const cookie = siteCookieHeader(await session.context.cookies(), site.cookieDomain);
  try {
    session.account = session.accountId
      ? accountPool.update(session.accountId, { cookie })
      : accountPool.create({
          name: session.name || `${site.label}扫码 ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
          provider: session.provider,
          cookie,
        });
    await finish(session, "success");
    logger.info(`扫码登录成功，已${session.accountId ? "更新" : "添加"}${site.label}账号「${session.account.name}」`);
  } catch (error: any) {
    await finish(session, "error", error?.message || String(error));
  }
}

async function finish(session: QrLoginSession, status: QrLoginStatus, error?: string) {
  session.timers.forEach((timer) => clearTimeout(timer));
  session.timers = [];
  session.status = status;
  if (error) session.error = error;
  session.page = null;
  await session.context.close().catch(() => undefined);
  // 保留结果一段时间供前端读取，然后清理
  setTimeout(() => sessions.delete(session.id), 60_000).unref?.();
}

function getSession(id: string): QrLoginSession {
  const session = sessions.get(id);
  if (!session) throw new Error("扫码登录会话不存在或已过期");
  return session;
}

function publicSession(session: QrLoginSession) {
  return {
    id: session.id,
    provider: session.provider,
    status: session.status,
    error: session.error || null,
    account: session.account || null,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

export function getQrLogin(id: string) {
  return publicSession(getSession(id));
}

export async function screenshotQrLogin(id: string): Promise<Buffer> {
  const session = getSession(id);
  if (session.status !== "waiting" || !session.page) throw new Error("登录已结束");
  return await session.page.screenshot({ type: "jpeg", quality: 70 });
}

export type QrLoginInput =
  | { type: "click"; x: number; y: number }
  | { type: "drag"; x: number; y: number; toX: number; toY: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string };

const ALLOWED_KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/** 转发用户在控制台画面上的操作（坐标为页面视口像素） */
export async function inputQrLogin(id: string, input: QrLoginInput) {
  const session = getSession(id);
  if (session.status !== "waiting" || !session.page) throw new Error("登录已结束");
  const page = session.page;
  const point = (v: unknown) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 4000) throw new Error("坐标无效");
    return n;
  };
  if (input.type === "click") return void (await page.mouse.click(point(input.x), point(input.y)));
  if (input.type === "drag") {
    await page.mouse.move(point(input.x), point(input.y));
    await page.mouse.down();
    await page.mouse.move(point(input.toX), point(input.toY), { steps: 20 });
    return void (await page.mouse.up());
  }
  if (input.type === "text") {
    if (typeof input.text !== "string" || input.text.length > 100) throw new Error("文本无效");
    return void (await page.keyboard.type(input.text, { delay: 30 }));
  }
  if (input.type === "key") {
    if (!ALLOWED_KEYS.has(input.key)) throw new Error("按键无效");
    return void (await page.keyboard.press(input.key));
  }
  throw new Error("操作类型无效");
}

export async function cancelQrLogin(id: string) {
  const session = sessions.get(id);
  if (session && session.status === "waiting") await finish(session, "error", "已取消");
}
