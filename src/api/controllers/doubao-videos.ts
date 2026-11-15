import crypto from "crypto";
import fs from "fs-extra";
import path from "path";
import axios from "axios";
import FormData from "form-data";
import mime from "mime";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";

const BASE_URL = "https://www.doubao.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const CHROMIUM_BUILD = "148.0.7816.0";
const DEFAULT_DEVICE_ID = "7698374278500353570";
const DEFAULT_WEB_ID = "7698374278500353570";
const DEFAULT_FP = "verify_mvfb2gzc_nST1AVAS_3Mpe_4uAR_8WAF_mxtjs";
const EXTENSION_BOT_ID = "7338286299411103781";
const FILE_MAX_SIZE = 100 * 1024 * 1024;

export const DEFAULT_DOUBAO_VIDEO_MODEL = "doubao-seedance-2.0-mini";
export const DOUBAO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];

export interface DoubaoVideoModelDef {
  id: string;
  upstream: string;
  name: string;
  description: string;
  aliases: string[];
  needSubscription: boolean;
}

export const DOUBAO_VIDEO_MODELS: DoubaoVideoModelDef[] = [
  {
    id: "doubao-seedance-2.0-mini",
    upstream: "seedance_v2.0_mini",
    name: "Doubao Seedance 2.0 Mini",
    description: "豆包 Seedance 2.0 Mini 视频模型（日常生成，可用每日免费额度）",
    aliases: ["seedance_v2.0_mini", "doubao-video-seedance-2.0-mini"],
    needSubscription: false,
  },
  {
    id: "doubao-seedance-2.0-fast",
    upstream: "seedance_v2.0",
    name: "Doubao Seedance 2.0 Fast",
    description: "豆包 Seedance 2.0 Fast 视频模型（快速出片，可用每日免费额度）",
    aliases: ["seedance_v2.0", "doubao-video-seedance-2.0-fast"],
    needSubscription: false,
  },
  {
    id: "doubao-seedance-2.0",
    upstream: "seedance_v2.0_std",
    name: "Doubao Seedance 2.0",
    description: "豆包 Seedance 2.0 标准版视频模型（进阶画面・2倍消耗，需豆包订阅）",
    aliases: ["seedance_v2.0_std", "doubao-video-seedance-2.0"],
    needSubscription: true,
  },
  {
    id: "doubao-seedance-2.5",
    upstream: "seedance_v2.5",
    name: "Doubao Seedance 2.5",
    description: "豆包 Seedance 2.5 旗舰视频模型（5倍消耗，需豆包订阅）",
    aliases: ["seedance_v2.5", "doubao-video-seedance-2.5"],
    needSubscription: true,
  },
];

export function resolveDoubaoModel(model?: string): DoubaoVideoModelDef | undefined {
  if (!model) return undefined;
  const key = model.trim();
  return DOUBAO_VIDEO_MODELS.find((m) => m.id === key || m.upstream === key || m.aliases.includes(key));
}

export function isDoubaoVideoModel(model?: string): boolean {
  return Boolean(resolveDoubaoModel(model));
}

export function resolveDoubaoCookie(rawCredential: string): {
  cookieHeader: string;
  csrfToken: string;
  msToken: string;
} {
  const raw = (rawCredential || "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^\s*cookie\s*:\s*/i, "")
    .replace(/[\r\n]+/g, "; ");
  if (!raw) throw new APIException(EX.API_TOKEN_EXPIRES, "豆包 Cookie 凭据为空");

  if (!raw.includes("=") && /^[^\s;]+$/.test(raw)) {
    return { cookieHeader: `sessionid=${raw}; sessionid_ss=${raw}; sid_tt=${raw}`, csrfToken: "", msToken: "" };
  }

  const pairs = new Map<string, string>();
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k && v) pairs.set(k, v);
  }

  const lower = new Map<string, string>();
  for (const [k, v] of pairs) lower.set(k.toLowerCase(), v);

  let sessionId = lower.get("sessionid") || lower.get("sessionid_ss") || lower.get("sid_tt") || "";
  if (!sessionId) {
    const guard = lower.get("sid_guard") || "";
    sessionId = guard.split("%7C")[0] || guard.split("|")[0] || "";
  }
  if (!sessionId) {
    throw new APIException(EX.API_TOKEN_EXPIRES, "豆包 Cookie 中缺少 sessionid / sessionid_ss / sid_tt");
  }
  if (!lower.has("sessionid")) pairs.set("sessionid", sessionId);

  const cookieHeader = [...pairs.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const csrfToken = lower.get("passport_csrf_token") || lower.get("passport_csrf_token_default") || "";
  const msToken = lower.get("mstoken") || "";
  return { cookieHeader, csrfToken, msToken };
}

function samanthaParams(msToken = ""): Record<string, string> {
  const params: Record<string, string> = {
    aid: "582478",
    real_aid: "582478",
    device_id: DEFAULT_DEVICE_ID,
    tea_uuid: DEFAULT_DEVICE_ID,
    web_id: DEFAULT_WEB_ID,
    device_platform: "web",
    language: "zh",
    region: "CN",
    sys_region: "CN",
    pkg_type: "release_version",
    version_code: "20800",
    pc_version: "2.1.7",
    chromium_version: CHROMIUM_BUILD,
    client_platform: "pc_client",
    runtime: "web",
    runtime_version: "3.5.4",
    samantha_web: "1",
    "use-olympus-account": "1",
    fp: DEFAULT_FP,
    web_tab_id: crypto.randomUUID(),
  };
  if (msToken) params.msToken = msToken;
  return params;
}

function abilityParams(): Record<string, string> {
  return {
    aid: "497858",
    real_aid: "497858",
    device_id: DEFAULT_DEVICE_ID,
    tea_uuid: DEFAULT_DEVICE_ID,
    web_id: DEFAULT_WEB_ID,
    device_platform: "web",
    doubao_device_platform: "web",
    doubao_pc_version: "3.41.4",
    language: "zh",
    region: "CN",
    sys_region: "CN",
    pkg_type: "release_version",
    version_code: "20800",
    pc_version: "3.41.4",
    chromium_version: CHROMIUM_BUILD,
    client_platform: "pc_client",
    runtime: "web",
    runtime_version: "3.5.4",
    samantha_web: "1",
    "use-olympus-account": "1",
    fp: DEFAULT_FP,
    web_tab_id: crypto.randomUUID(),
  };
}

function buildQuery(params: Record<string, string>): string {
  const sp = new URLSearchParams();
  for (const key of Object.keys(params).sort()) sp.set(key, params[key]);
  return sp.toString();
}

export function buildVideoAbilityPayload(
  prompt: string,
  upstreamModel: string,
  duration: 5 | 10,
  ratio: string
): Record<string, any> {
  const nowMs = Date.now();
  const inner = {
    ratio: ratio || "16:9",
    model: upstreamModel,
    duration,
    input_box_content: {
      user_input_content: prompt,
      reply_message_format: "生成视频：%s",
    },
  };
  return {
    client_meta: {
      local_conversation_id: `local_${nowMs}`,
      conversation_id: "",
      bot_id: EXTENSION_BOT_ID,
      last_section_id: "",
      last_message_index: null,
      local_permissions: [
        { permission_name: "ACCESS_COARSE_LOCATION", status: 3 },
        { permission_name: "ACCESS_FINE_LOCATION", status: 3 },
        { permission_name: "ACCESS_BACKGROUND_LOCATION", status: 3 },
      ],
    },
    messages: [
      {
        local_message_id: crypto.randomUUID(),
        content_block: [
          {
            block_type: 10000,
            content: {
              text_block: {
                text: `生成视频：${prompt}，${duration}s`,
                icon_url: "",
                icon_url_dark: "",
                summary: "",
              },
              pc_event_block: "",
            },
            block_id: crypto.randomUUID(),
            parent_id: "",
            meta_info: [],
            extra_info: {},
            append_fields: [],
          },
        ],
        message_status: 0,
      },
    ],
    option: {
      send_message_scene: "",
      create_time_ms: nowMs,
      collect_id: "",
      is_audio: false,
      answer_with_suggest: false,
      tts_switch: false,
      need_deep_think: 0,
      click_clear_context: false,
      from_suggest: false,
      is_regen: false,
      is_replace: false,
      is_from_click_option: false,
      is_from_click_softlink: false,
      disable_sse_cache: false,
      select_text_action: "",
      is_select_text: false,
      resend_for_regen: false,
      scene_type: 0,
      unique_key: crypto.randomUUID(),
      start_seq: 0,
      need_create_conversation: true,
      conversation_init_option: { need_ack_conversation: true },
      regen_query_id: [],
      edit_query_id: [],
      regen_instruction: "",
      no_replace_for_regen: false,
      message_from: 0,
      shared_app_name: "",
      shared_app_id: "",
      sse_recv_event_options: { support_chunk_delta: true },
      support_lazy_fetch_stream: true,
      is_ai_playground: false,
      is_old_user: true,
      general_task_param: { server_do_compare: true },
      recovery_option: {
        is_recovery: false,
        req_create_time_sec: Math.floor(nowMs / 1000),
        append_sse_event_scene: 0,
      },
      message_storage_type: 0,
      related_deleted_message_ids: {},
      connector_info_list: [],
      model_config: { model_item_key: "", model_extra_params: {} },
      aggregate_params: {
        mention_skill_list: "[]",
        mention_plugin_list: "[]",
        mention_ext: "[{}]",
        conversation_mode: "1",
        mode_id: "",
        model_item_key: "",
        agent_mode: "",
        reasoning_effort: "",
        provider_id: "",
      },
      conversation_mode: 1,
    },
    chat_ability: {
      ability_type: 17,
      ability_param: JSON.stringify(inner),
    },
    user_context: [],
    ext: {
      answer_with_suggest: "0",
      sub_conv_firstmet_type: "1",
      general_task_param: '{"server_do_compare":true}',
      collection_id: "",
      is_finish: "1",
      conversation_init_option: '{"need_ack_conversation":true}',
      commerce_credit_config_enable: "0",
    },
  };
}

export function parseAbilityAck(rawSse: string): {
  convId: string;
  localId: string;
  agentText: string;
  errorCode?: string | number;
  errorMessage?: string;
} {
  let convId = "";
  let localId = "";
  let errorCode: string | number | undefined;
  let errorMessage: string | undefined;
  const texts: string[] = [];

  for (const block of (rawSse || "").split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let eventName = "";
    let dataStr = "";
    for (const line of block.trim().split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
    }
    if (!dataStr) continue;
    let data: any;
    try {
      data = JSON.parse(dataStr);
    } catch {
      continue;
    }
    if (eventName === "STREAM_ERROR" || eventName === "gateway-error") {
      errorCode = data.error_code ?? data.code;
      errorMessage = data.error_msg || data.message || dataStr.slice(0, 200);
      continue;
    }
    if (eventName === "SSE_ACK") {
      const meta = data.ack_client_meta || {};
      const cid = String(meta.conversation_id || "");
      if (/^\d{15,}$/.test(cid)) convId = cid;
      if (meta.local_conversation_id) localId = String(meta.local_conversation_id);
    }
    for (const patch of data.patch_op || []) {
      const pv = patch?.patch_value;
      if (!pv || typeof pv !== "object") continue;
      for (const cb of pv.content_block || []) {
        if (cb?.block_type === 10000 && cb?.content?.text_block?.text) {
          texts.push(String(cb.content.text_block.text));
        }
      }
    }
    if (eventName === "CHUNK_DELTA") {
      const delta = data.text || data.delta || "";
      if (delta) texts.push(String(delta));
    }
  }
  return { convId, localId, agentText: texts.join("").trim(), errorCode, errorMessage };
}

export function isVideoConfirmCard(agentText: string): boolean {
  return Boolean(agentText && agentText.includes("确认") && (agentText.includes("参数") || agentText.includes("确认后")));
}

export function parseSamanthaSse(rawSse: string): {
  convId: string;
  agentText: string;
  syncVideoUrl: string;
  asyncTaskId: string;
  errorMessage?: string;
} {
  let convId = "";
  let agentText = "";
  let syncVideoUrl = "";
  let asyncTaskId = "";
  let errorMessage: string | undefined;

  for (const block of (rawSse || "").split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let eventName = "";
    let dataStr = "";
    for (const line of block.trim().split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
    }
    if (!dataStr) continue;
    let outer: any;
    try {
      outer = JSON.parse(dataStr);
    } catch {
      continue;
    }
    if (eventName === "gateway-error" || outer.event_type === 2005) {
      errorMessage = String(outer.message || outer.event_data || dataStr).slice(0, 300);
      continue;
    }
    if (outer.event_type !== 2001) continue;
    let ed = outer.event_data;
    if (typeof ed === "string") {
      try {
        ed = JSON.parse(ed);
      } catch {
        continue;
      }
    }
    if (!ed || typeof ed !== "object") continue;

    const cid = String(ed.conversation_id || "");
    if (/^\d{15,}$/.test(cid)) convId = cid;
    if (ed.tts_content) agentText += String(ed.tts_content);
    if (ed.fin_reason?.reason === 1 && ed.fin_reason?.async_task?.id) {
      asyncTaskId = String(ed.fin_reason.async_task.id);
    }

    const msg = ed.message;
    if (msg?.content_type === 2001 && typeof msg.content === "string") {
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed?.text && !ed.tts_content) agentText += String(parsed.text);
      } catch {
        /* ignore */
      }
    } else if (msg?.content_type === 2021) {
      try {
        const content = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content;
        const items = Array.isArray(content?.data) ? content.data : [content];
        for (const item of items) {
          const decoded = decodeVideoModelUrl(item?.video_model) || item?.video_url || item?.url || "";
          if (decoded) {
            syncVideoUrl = decoded;
            break;
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  return { convId, agentText: agentText.trim(), syncVideoUrl, asyncTaskId, errorMessage };
}

function decodeVideoModelUrl(videoModelRaw: unknown): string {
  if (!videoModelRaw) return "";
  try {
    const vm = typeof videoModelRaw === "string" ? JSON.parse(videoModelRaw) : videoModelRaw;
    const list = (vm as any)?.video_list || {};
    for (const key of ["video_1", "video_2", ...Object.keys(list)]) {
      const mainB64 = list[key]?.main_url;
      if (typeof mainB64 === "string" && mainB64) {
        return Buffer.from(mainB64, "base64").toString("utf8");
      }
    }
  } catch {
    /* ignore */
  }
  return "";
}

export function extractVideoFromMessages(messages: any[]): {
  url: string;
  vid: string;
} | null {
  for (const m of messages || []) {
    const rawContent = m?.content;
    if (typeof rawContent !== "string" || !rawContent.includes("2074")) continue;
    let blocks: any;
    try {
      blocks = JSON.parse(rawContent);
    } catch {
      continue;
    }
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (b?.block_type !== 2074) continue;
      let card: any;
      try {
        card = typeof b.content === "string" ? JSON.parse(b.content) : b.content;
      } catch {
        continue;
      }
      for (const cr of card?.creations || []) {
        const v = cr?.video;
        if (!v) continue;
        // Prefer video_model.video_list.video_1.main_url (full 720p MP4); v.download_url can be truncated.
        const url = decodeVideoModelUrl(v.video_model) || v.download_url || "";
        const vid = String(v.vid || v.video_id || v.id || "");
        if (url) return { url, vid };
      }
    }
  }
  return null;
}

export function extractCleanVideoUrl(payload: any): string {
  const data = payload?.data;
  if (!data?.without_watermark) return "";
  const dw = data.download_video || {};
  for (const entry of Object.values(dw) as any[]) {
    const u = entry?.download_url;
    if (typeof u === "string" && u) return u;
  }
  return "";
}

export function classifyDoubaoFailure(rawText: string, agentReply: string): APIException | null {
  const combined = `${rawText || ""}\n${agentReply || ""}`;

  if (
    combined.includes("710012001") ||
    agentReply.includes("登录已过期") ||
    agentReply.includes("请先登录") ||
    combined.includes("session expired")
  ) {
    return new APIException(EX.API_TOKEN_EXPIRES, "豆包账号登录已过期，请更新 Cookie");
  }

  if (combined.includes("710022002") || combined.includes("710022004")) {
    const ex = new APIException(
      EX.API_RISK_CONTROL_REJECTED,
      "请求被豆包风控网关拦截（710022002/710022004，IP 级限流），请稍后重试或更换网络环境"
    );
    (ex as any).isIpRiskControl = true;
    return ex;
  }

  if (
    agentReply.includes("免费次数用完") ||
    (agentReply.includes("今日") && agentReply.includes("用完"))
  ) {
    return new APIException(
      EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS,
      `当前豆包账号今日免费视频次数已用完: ${agentReply.slice(0, 120)}`
    );
  }

  if (
    ["免费体验套餐", "升级正式订阅", "不可用于创作", "订阅标准套餐专属能力", "无该视频模型"].some((kw) =>
      agentReply.includes(kw)
    )
  ) {
    return new APIException(
      EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS,
      `当前豆包账号无所选视频模型额度（免费账号请选 2.0-mini / 2.0-fast，或切换订阅账号）: ${agentReply.slice(0, 120)}`
    );
  }

  if (agentReply.includes("不符合") && (agentReply.includes("规范") || agentReply.includes("安全") || agentReply.includes("合规"))) {
    return new APIException(EX.API_CONTENT_FILTERED, `提示词被豆包安全审核拦截: ${agentReply.slice(0, 120)}`);
  }

  return null;
}

async function readImageInput(source: string): Promise<{ buffer: Buffer; ext: string; mimeType: string }> {
  const trimmed = source.trim();
  if (trimmed.startsWith("data:")) {
    const m = /^data:([^;,]+)?;base64,(.+)$/i.exec(trimmed);
    if (!m) throw new APIException(EX.API_FILE_URL_INVALID, "参考图 Base64 Data URI 格式无效");
    const mimeType = m[1] || "image/png";
    const buffer = Buffer.from(m[2], "base64");
    if (buffer.length > FILE_MAX_SIZE) throw new APIException(EX.API_FILE_EXECEEDS_SIZE, "参考图超出大小限制");
    const ext = (mime.getExtension(mimeType) || "png").replace(/^jpeg$/, "jpg");
    return { buffer, ext, mimeType };
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const res = await axios.get<ArrayBuffer>(trimmed, {
      responseType: "arraybuffer",
      timeout: 60_000,
      maxContentLength: FILE_MAX_SIZE,
    });
    const buffer = Buffer.from(res.data);
    const mimeType = String(res.headers["content-type"] || "image/png").split(";")[0].trim();
    const ext = (mime.getExtension(mimeType) || "png").replace(/^jpeg$/, "jpg");
    return { buffer, ext, mimeType };
  }
  if (!(await fs.pathExists(trimmed))) {
    throw new APIException(EX.API_FILE_URL_INVALID, `本地参考图不存在: ${trimmed}`);
  }
  const buffer = await fs.readFile(trimmed);
  if (buffer.length > FILE_MAX_SIZE) throw new APIException(EX.API_FILE_EXECEEDS_SIZE, "参考图超出大小限制");
  const mimeType = mime.getType(path.basename(trimmed)) || "image/png";
  const ext = (mime.getExtension(mimeType) || "png").replace(/^jpeg$/, "jpg");
  return { buffer, ext, mimeType };
}

export async function uploadDoubaoImage(
  source: string,
  cookieHeader: string,
  csrfToken = "",
  msToken = ""
): Promise<string> {
  const { buffer, ext, mimeType } = await readImageInput(source);
  const qs = buildQuery(samanthaParams(msToken));

  const form = new FormData();
  form.append("data", buffer, { filename: `frame.${ext}`, contentType: mimeType });
  form.append("file_type", ext);

  const upRes = await axios.post(`${BASE_URL}/samantha/pages/upload_image?${qs}`, form, {
    headers: {
      ...form.getHeaders(),
      "User-Agent": USER_AGENT,
      Origin: BASE_URL,
      Referer: `${BASE_URL}/chat`,
      Cookie: cookieHeader,
      ...(csrfToken ? { "x-tt-passport-csrf-token": csrfToken } : {}),
    },
    timeout: 60_000,
    maxBodyLength: FILE_MAX_SIZE,
  });

  if (upRes.data?.code !== 0 || !upRes.data?.data?.uri) {
    const msg = upRes.data?.msg || JSON.stringify(upRes.data).slice(0, 200);
    if (upRes.data?.code === 710012001) {
      throw new APIException(EX.API_TOKEN_EXPIRES, `豆包图片上传鉴权失败: ${msg}`);
    }
    throw new APIException(EX.API_REQUEST_FAILED, `豆包参考图上传失败: ${msg}`);
  }

  const uriShort = upRes.data.data.uri;
  const urlRes = await axios.post(
    `${BASE_URL}/alice/message/get_file_url?${buildQuery(samanthaParams(msToken))}`,
    { uris: [uriShort], type: "image", format: ext, expire_second: 3600 },
    {
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        Origin: BASE_URL,
        Referer: `${BASE_URL}/chat`,
        Cookie: cookieHeader,
      },
      timeout: 30_000,
    }
  );

  const fileUri = urlRes.data?.data?.file_urls?.[0]?.uri;
  if (urlRes.data?.code !== 0 || !fileUri) {
    throw new APIException(EX.API_REQUEST_FAILED, `豆包参考图换链失败: ${urlRes.data?.msg || "empty file_urls"}`);
  }
  return String(fileUri);
}

async function postAbilitySse(payload: Record<string, any>, cookieHeader: string): Promise<string> {
  const url = `${BASE_URL}/chat/completion?${buildQuery(abilityParams())}`;
  const res = await axios.post<string>(url, JSON.stringify(payload), {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "Agw-Js-Conv": "str",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/chat/`,
      Cookie: cookieHeader,
    },
    responseType: "text",
    transformResponse: [(v) => v],
    timeout: 180_000,
  });
  return String(res.data || "");
}

async function snapshotConversationIds(cookieHeader: string, msToken: string): Promise<Set<string>> {
  try {
    const res = await axios.post(
      `${BASE_URL}/samantha/im/conversation/list?${buildQuery(samanthaParams(msToken))}`,
      {},
      {
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/json",
          Origin: BASE_URL,
          Referer: `${BASE_URL}/chat`,
          Cookie: cookieHeader,
        },
        timeout: 20_000,
      }
    );
    const list = res.data?.data?.thread_list || [];
    const ids = new Set<string>();
    for (const item of list) {
      const cid = item?.conversation?.conversation_id;
      if (cid) ids.add(String(cid));
    }
    return ids;
  } catch {
    return new Set();
  }
}

async function discoverNewConversationId(
  beforeIds: Set<string>,
  cookieHeader: string,
  msToken: string
): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const current = await snapshotConversationIds(cookieHeader, msToken);
    for (const cid of current) {
      if (!beforeIds.has(cid)) return cid;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  return "";
}

async function tryUpgradeCleanVideoUrl(
  vid: string,
  convId: string,
  cookieHeader: string
): Promise<string> {
  if (!vid || !convId) return "";
  try {
    const params: Record<string, string> = {
      version_code: "20800",
      language: "zh",
      device_platform: "web",
      doubao_device_platform: "web",
      aid: "497858",
      real_aid: "497858",
      pkg_type: "release_version",
      device_id: DEFAULT_DEVICE_ID,
      pc_version: "3.42.3",
      doubao_pc_version: "3.42.3",
      web_id: DEFAULT_WEB_ID,
      tea_uuid: DEFAULT_WEB_ID,
      region: "CN",
      sys_region: "CN",
      samantha_web: "1",
      web_platform: "browser",
      "use-olympus-account": "1",
      web_tab_id: crypto.randomUUID(),
    };
    const url = `${BASE_URL}/creativity/resource/get_without_watermark?${buildQuery(params)}&vid=${encodeURIComponent(vid)}`;
    const res = await axios.post(url, "{}", {
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        Origin: BASE_URL,
        Referer: `${BASE_URL}/chat/${convId}`,
        Cookie: cookieHeader,
      },
      timeout: 20_000,
    });
    return extractCleanVideoUrl(res.data);
  } catch (err: any) {
    logger.warn(`豆包无水印链接换取失败，回退原视频链接: ${err?.message || err}`);
    return "";
  }
}

async function pollConversationVideo(
  convId: string,
  cookieHeader: string,
  msToken: string,
  pollIntervalMs: number,
  pollTimeoutMs: number
): Promise<string> {
  const deadline = Date.now() + pollTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await axios.post(
        `${BASE_URL}/alice/conversation/latest_messagelist?${buildQuery(samanthaParams(msToken))}`,
        {
          request_list: [{ conversation_id: String(convId), message_index: 0, count: 20 }],
        },
        {
          headers: {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
            Origin: BASE_URL,
            Referer: `${BASE_URL}/chat`,
            Cookie: cookieHeader,
          },
          timeout: 30_000,
        }
      );

      if (res.data?.code === 710012001) {
        throw new APIException(EX.API_TOKEN_EXPIRES, "豆包登录态已过期");
      }

      const msgs: any[] = [];
      for (const group of Object.values(res.data?.data?.message_map || {})) {
        if (Array.isArray(group)) msgs.push(...group);
      }
      msgs.sort((a, b) => Number(a?.index || 0) - Number(b?.index || 0));

      const found = extractVideoFromMessages(msgs);
      if (found?.url) {
        const cleanUrl = await tryUpgradeCleanVideoUrl(found.vid, convId, cookieHeader);
        return cleanUrl || found.url;
      }
    } catch (err) {
      if (err instanceof APIException) throw err;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new APIException(
    EX.API_VIDEO_GENERATION_FAILED,
    `等待豆包视频渲染超时（会话 https://www.doubao.com/chat/${convId} ），可稍后在豆包会话中查看`
  );
}

export async function generateDoubaoVideo(
  _model: string,
  prompt: string,
  options: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
    pollIntervalMs?: number;
    pollTimeoutMs?: number;
  } = {},
  rawCredential: string
): Promise<string> {
  const cleanPrompt = (prompt || "").trim();
  if (!cleanPrompt) throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "视频提示词不能为空");

  const modelDef = resolveDoubaoModel(_model) || DOUBAO_VIDEO_MODELS[0];
  // shortcut: Doubao web only accepts 5s or 10s durations (>=8 snaps to 10, else 5); upgrade if upstream adds arbitrary durations
  const duration: 5 | 10 = options.duration && options.duration >= 8 ? 10 : 5;
  const ratio = options.ratio && DOUBAO_RATIOS.includes(options.ratio) ? options.ratio : "16:9";
  const pollIntervalMs = options.pollIntervalMs ?? 8_000;
  const pollTimeoutMs = options.pollTimeoutMs ?? 600_000;

  const { cookieHeader, csrfToken, msToken } = resolveDoubaoCookie(rawCredential);
  const sources = (options.filePaths || []).filter(Boolean);

  // shortcut: Samantha/Doubao image-to-video attaches reference frames; first image acts as reference/first frame
  const refKeys: string[] = [];
  for (const src of sources.slice(0, 2)) {
    refKeys.push(await uploadDoubaoImage(src, cookieHeader, csrfToken, msToken));
  }

  logger.info(
    `🎬 [豆包视频] 提交任务 model=${modelDef.id} (${modelDef.upstream}), duration=${duration}s, ratio=${ratio}, refs=${refKeys.length}`
  );

  // 1) 文生视频优先走新统一端点 /chat/completion + chat_ability(17)，精确指定模型与时长
  if (refKeys.length === 0) {
    try {
      const payload = buildVideoAbilityPayload(cleanPrompt, modelDef.upstream, duration, ratio);
      const raw = await postAbilitySse(payload, cookieHeader);
      const ack = parseAbilityAck(raw);
      const failure = classifyDoubaoFailure(raw, ack.agentText);
      if (failure) throw failure;

      let convId = ack.convId;
      let agentText = ack.agentText;

      if (convId && isVideoConfirmCard(agentText)) {
        logger.info(`🎬 [豆包视频] 收到参数确认卡，自动回复「确认」 conv=${convId}`);
        const confirmPayload = buildVideoAbilityPayload(cleanPrompt, modelDef.upstream, duration, ratio);
        confirmPayload.client_meta.local_conversation_id = ack.localId || `local_${Date.now()}`;
        confirmPayload.client_meta.conversation_id = convId;
        confirmPayload.messages[0].content_block[0].content.text_block.text = "确认";
        confirmPayload.option.need_create_conversation = false;

        const raw2 = await postAbilitySse(confirmPayload, cookieHeader);
        const ack2 = parseAbilityAck(raw2);
        const failure2 = classifyDoubaoFailure(raw2, ack2.agentText);
        if (failure2) throw failure2;
        if (ack2.agentText) agentText = ack2.agentText;
      }

      if (convId) {
        return await pollConversationVideo(convId, cookieHeader, msToken, pollIntervalMs, pollTimeoutMs);
      }
      logger.warn(`豆包新端点未返回有效会话 ID（回复: ${agentText.slice(0, 100)}），回退 samantha 通道`);
    } catch (err: any) {
      if (err instanceof APIException) throw err;
      logger.warn(`豆包新端点请求异常（${err?.message || err}），回退 samantha 通道`);
    }
  }

  // 2) 图生视频 / 兜底通道：/samantha/chat/completion (content_type=2020, skill_type=17, memory_type=0)
  const beforeIds = await snapshotConversationIds(cookieHeader, msToken);
  const contentDict: Record<string, any> = {
    text: `帮我生成一个视频：${cleanPrompt}\n参数：${modelDef.name.replace(/^Doubao\s+/, "")}，时长 ${duration} 秒、比例 ${ratio}。请直接开始生成，不要再向我确认参数。`,
    "video-model": modelDef.upstream,
    "video-duration": String(duration),
    "video-ratio": ratio,
  };

  const samanthaBody = {
    messages: [
      {
        content: JSON.stringify(contentDict),
        content_type: 2020,
        attachments: refKeys.map((key) => ({ type: "image", key })),
        references: [],
        skill: {
          skill_type: 17,
          skill_type_no_default: 17,
          skill_id: "17",
          skill_id_no_default: "17",
        },
      },
    ],
    completion_option: {
      is_regen: false,
      with_suggest: true,
      need_create_conversation: true,
      launch_stage: 2,
      is_replace: false,
      is_delete: false,
      is_ai_playground: false,
      memory_type: 0,
      message_from: 0,
      use_deep_think: false,
      use_auto_cot: false,
      resend_for_regen: false,
      enable_commerce_credit: false,
      action_bar_skill_id: 17,
    },
    evaluate_option: { web_ab_params: "" },
    local_conversation_id: crypto.randomUUID(),
    local_message_id: crypto.randomUUID(),
  };

  const samRes = await axios.post<string>(
    `${BASE_URL}/samantha/chat/completion?${buildQuery(samanthaParams(msToken))}`,
    JSON.stringify(samanthaBody),
    {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "Agw-Js-Conv": "str",
        Origin: BASE_URL,
        Referer: `${BASE_URL}/chat`,
        Cookie: cookieHeader,
      },
      responseType: "text",
      transformResponse: [(v) => v],
      timeout: 180_000,
    }
  );

  const rawSam = String(samRes.data || "");
  const parsed = parseSamanthaSse(rawSam);
  const failure = classifyDoubaoFailure(rawSam, parsed.agentText);
  if (failure) throw failure;
  if (parsed.errorMessage) {
    throw new APIException(EX.API_VIDEO_GENERATION_FAILED, `豆包视频提交失败: ${parsed.errorMessage}`);
  }
  if (parsed.syncVideoUrl) return parsed.syncVideoUrl;

  if (parsed.asyncTaskId) {
    const asyncParams = samanthaParams(msToken);
    delete asyncParams.fp;
    const asyncRes = await axios.post<string>(
      `${BASE_URL}/samantha/chat/async/stream?${buildQuery(asyncParams)}`,
      JSON.stringify({ task_id: parsed.asyncTaskId, event_id: 0 }),
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          "Agw-Js-Conv": "str",
          Origin: BASE_URL,
          Referer: `${BASE_URL}/chat`,
          Cookie: cookieHeader,
        },
        responseType: "text",
        transformResponse: [(v) => v],
        timeout: 300_000,
      }
    );
    const asyncParsed = parseSamanthaSse(String(asyncRes.data || ""));
    if (asyncParsed.syncVideoUrl) return asyncParsed.syncVideoUrl;
  }

  const convId = parsed.convId || (await discoverNewConversationId(beforeIds, cookieHeader, msToken));
  if (!convId) {
    throw new APIException(
      EX.API_VIDEO_GENERATION_FAILED,
      `豆包视频未创建有效会话（回复: ${parsed.agentText.slice(0, 140) || "空"}）`
    );
  }
  return await pollConversationVideo(convId, cookieHeader, msToken, pollIntervalMs, pollTimeoutMs);
}

export async function getDoubaoAccountStatus(rawCredential: string): Promise<{
  freeCredit: number | null;
  totalCredit: number | null;
  membership: string;
}> {
  const { cookieHeader, msToken } = resolveDoubaoCookie(rawCredential);
  const res = await axios.post(
    `${BASE_URL}/samantha/video/query_video_gen_info?${buildQuery(samanthaParams(msToken))}`,
    {},
    {
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        Origin: BASE_URL,
        Referer: `${BASE_URL}/chat`,
        Cookie: cookieHeader,
      },
      timeout: 20_000,
    }
  );

  const body = res.data;
  if (typeof body?.code === "number" && body.code !== 0) {
    throw new Error(body.msg || `豆包状态查询失败 (code=${body.code})`);
  }
  const data = body?.data || {};
  const remain = typeof data.remain_count === "number" ? data.remain_count : null;
  const label = data.is_beta_user ? "豆包视频可用" : "豆包正常";
  return {
    freeCredit: remain,
    totalCredit: remain,
    membership: label,
  };
}
