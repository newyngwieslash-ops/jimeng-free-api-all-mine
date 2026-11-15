import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-seedance-test-"));
const testPort = 18900 + Math.floor(Math.random() * 500);
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.JIMENG_ACCOUNT_POOL_KEY = "unit-test-encryption-key-2026";
process.env.SERVER_PORT = String(testPort);
// 测试里不要用后真实刷新账号积分（会访问真实上游）
process.env.ACCOUNT_REFRESH_AFTER_USE = "false";

async function main() {
  const axiosMod = await import("axios");
  const axios = axiosMod.default;
  const APIException = (await import("@/lib/exceptions/APIException.ts")).default;
  const EX = (await import("@/api/consts/exceptions.ts")).default;
  const accountPool = (await import("@/lib/account-pool.ts")).default;
  const {
    executeWithPoolFailover,
    executeWithCredentialFailover,
    splitAuthCredentials,
  } = await import("@/api/controllers/auth.ts");
  const {
    buildVideoAbilityPayload,
    classifyDoubaoFailure,
    decodeDoubaoMainUrl,
    extractCleanVideoUrl,
    extractVideoFromMessages,
    generateDoubaoVideo,
    isDoubaoVideoModel,
    isVideoConfirmCard,
    parseAbilityAck,
    resolveDoubaoCookie,
    resolveLocalVideoPath,
    resolveUnwatermarkedFromFallbackApi,
  } = await import("@/api/controllers/doubao-videos.ts");

  assert.equal(resolveLocalVideoPath("../evil.mp4"), null);
  assert.ok(resolveLocalVideoPath("doubao_test123.mp4")?.endsWith("doubao_test123.mp4"));

  // 1. Model & Cookie / Auth parsing checks
  assert.equal(isDoubaoVideoModel("doubao-seedance-2.0-mini"), true);
  assert.equal(isDoubaoVideoModel("seedance_v2.5"), true);
  assert.equal(isDoubaoVideoModel("jimeng-video-seedance-2.5"), false);

  const rawCookie =
    "sid_guard=sess_abc%7C1738570629%7C5184000%7CMon, 03-Feb-2025 08:17:09 GMT; ttwid=tt_123; passport_csrf_token=csrf_xyz";
  const parsedCookie = resolveDoubaoCookie(rawCookie);
  assert.ok(parsedCookie.cookieHeader.includes("sessionid=sess_abc"));
  assert.ok(parsedCookie.cookieHeader.includes("ttwid=tt_123"));
  assert.equal(parsedCookie.csrfToken, "csrf_xyz");

  assert.equal(splitAuthCredentials(`Bearer ${rawCookie}`).length, 1);
  assert.equal(splitAuthCredentials("Bearer sessionid=a; ttwid=1 || sessionid=b; ttwid=2").length, 2);
  assert.equal(splitAuthCredentials("Bearer tok1,tok2,tok3").length, 3);

  // 2. Ability payload, SSE confirm card, message polling & watermark-free URL checks
  const abilityPayload = buildVideoAbilityPayload("海浪拍打礁石", "seedance_v2.0_mini", 10, "16:9");
  assert.equal(abilityPayload.chat_ability.ability_type, 17);
  assert.equal(abilityPayload.option.message_storage_type, 0);
  const innerParam = JSON.parse(abilityPayload.chat_ability.ability_param);
  assert.equal(innerParam.model, "seedance_v2.0_mini");
  assert.equal(innerParam.duration, 10);

  const mockAckSse = [
    'event: SSE_ACK\ndata: {"ack_client_meta":{"conversation_id":"7488888888888888888","local_conversation_id":"local_123"}}',
    'event: STREAM_CHUNK\ndata: {"patch_op":[{"patch_value":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"请"}}}]}}]}',
    'event: CHUNK_DELTA\ndata: {"text":"先确认以下参数，确认后我再开始生成视频"}',
  ].join("\n\n");
  const ack = parseAbilityAck(mockAckSse);
  assert.equal(ack.convId, "7488888888888888888");
  assert.equal(ack.localId, "local_123");
  assert.equal(isVideoConfirmCard(ack.agentText), true);

  const fallbackB64 = Buffer.from("https://cdn.doubao.com/watermarked.mp4").toString("base64");
  const extracted = extractVideoFromMessages([
    {
      index: 2,
      content: JSON.stringify([
        {
          block_type: 2074,
          content: JSON.stringify({
            creations: [
              {
                video: {
                  vid: "v0200fg10000clean",
                  download_url: "https://cdn.doubao.com/truncated.mp4",
                  video_model: JSON.stringify({
                    video_list: { video_1: { main_url: fallbackB64, vwidth: 1280, vheight: 720 } },
                  }),
                },
              },
            ],
          }),
        },
      ]),
    },
  ]);
  assert.deepEqual(extracted, {
    url: "https://cdn.doubao.com/watermarked.mp4",
    vid: "v0200fg10000clean",
  });
  assert.equal(
    extractCleanVideoUrl({
      data: {
        without_watermark: true,
        download_video: { video_1: { download_url: "https://cdn.doubao.com/clean.mp4?lr=unwatermarked" } },
      },
    }),
    "https://cdn.doubao.com/clean.mp4?lr=unwatermarked"
  );

  // qAAB AES-128-CBC watermark-free master URL decryption & fallback_api SSRF guard checks
  const testKeySeedBytes = Buffer.alloc(32, 0x42);
  const testKeySeed = testKeySeedBytes.toString("base64");
  const qaabSalt = Buffer.from(
    "4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58",
    "hex"
  );
  const d1 = crypto.createHash("sha512").update(testKeySeedBytes).digest();
  const mat = crypto.createHash("sha512").update(Buffer.concat([d1, qaabSalt])).digest();
  const cleanMasterUrl = "https://v3-vdl.doubao.com/master_clean_720p.mp4?lr=unwatermarked";
  const cipher = crypto.createCipheriv("aes-128-cbc", mat.subarray(0, 16), mat.subarray(16, 32));
  const encryptedBody = Buffer.concat([cipher.update(cleanMasterUrl, "ascii"), cipher.final()]);
  const qaabToken = Buffer.concat([Buffer.from([0xa8, 0x00, 0x01, 0x00]), encryptedBody]).toString("base64");
  assert.ok(qaabToken.startsWith("qAAB"));
  assert.equal(decodeDoubaoMainUrl(qaabToken, testKeySeed), cleanMasterUrl);
  assert.equal(await resolveUnwatermarkedFromFallbackApi("https://evil.example.com/video/fplay/1/tok/vid"), "");
  assert.equal(await resolveUnwatermarkedFromFallbackApi("http://vas-lf-x.snssdk.com/video/fplay/1/tok/vid"), "");
  const mockFallbackApi = `https://vas-lf-x.snssdk.com/video/fplay/1/mock_tok/v0200fg10000clean?aid=482431&codec_type=5&logo_type=video_gen_watermark_dyn&key_seed=${encodeURIComponent(testKeySeed)}`;

  // Error classification checks
  assert.equal(classifyDoubaoFailure("", "今日免费次数用完")?.errcode, -2009);
  assert.equal(classifyDoubaoFailure("", "当前免费体验套餐不可用于创作")?.errcode, -2009);
  assert.equal(classifyDoubaoFailure("710012001", "")?.errcode, -2002);
  const riskEx = classifyDoubaoFailure("710022004", "");
  assert.equal(riskEx?.errcode, -2010);
  assert.equal((riskEx as any)?.isIpRiskControl, true);

  // 3. Multi-provider account pool isolation & automatic failover
  const acc1 = accountPool.create({
    name: "豆包1号",
    provider: "doubao",
    cookie: "sessionid=db_exhausted_001; ttwid=t1",
  });
  const acc2 = accountPool.create({
    name: "豆包2号",
    provider: "doubao",
    cookie: "sessionid=db_healthy_002; ttwid=t2; passport_csrf_token=csrf2",
  });
  // Same sessionid on jimeng should not collide with doubao hash
  const jmAcc = accountPool.create({
    name: "即梦1号",
    provider: "jimeng",
    cookie: "sessionid=db_healthy_002",
  });
  assert.equal(acc1.provider, "doubao");
  assert.equal(jmAcc.provider, "jimeng");
  assert.equal(accountPool.list("doubao").length, 2);
  assert.equal(accountPool.list("jimeng").length, 1);

  // Param error (-2000) must NOT mark account failed or failover
  await assert.rejects(
    () =>
      executeWithPoolFailover("doubao", async () => {
        throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "空提示词");
      }),
    /空提示词/
  );
  assert.equal(accountPool.get(acc1.id).failureCount, 0);

  // Errors after upstream submission (noFailover) must NOT retry on another credential
  let submittedCalls = 0;
  await assert.rejects(
    () =>
      executeWithCredentialFailover("Bearer tokA,tokB", "jimeng", async () => {
        submittedCalls++;
        throw Object.assign(new APIException(EX.API_VIDEO_GENERATION_FAILED, "已提交后超时"), { noFailover: true });
      }),
    /已提交后超时/
  );
  assert.equal(submittedCalls, 1);

  // Per-account concurrency: all accounts at the limit -> AccountBusyError (callers queue instead of failing)
  const { AccountBusyError } = await import("@/lib/account-pool.ts");
  for (const id of [acc1.id, acc1.id, acc2.id, acc2.id]) accountPool.acquire(id);
  assert.throws(
    () => accountPool.select("round_robin", { provider: "doubao", checkConcurrency: true }),
    (err: any) => err instanceof AccountBusyError
  );
  for (const id of [acc1.id, acc1.id, acc2.id, acc2.id]) accountPool.release(id);

  // Per-account device identity: stable for one account, different across accounts
  const { deviceIdentity } = await import("@/api/controllers/core.ts");
  assert.equal(deviceIdentity("sess_a").webId, deviceIdentity("sess_a").webId);
  assert.notEqual(deviceIdentity("sess_a").webId, deviceIdentity("sess_b").webId);
  assert.match(deviceIdentity("sess_a").webId, /^7\d{18}$/);

  // QR login: waits for the site's own sessionid (ignores douyin.com from the OAuth popup), then saves only site cookies
  const browserTransport = (await import("@/lib/browser-transport.ts")).default;
  let fakeCookies: Array<{ name: string; value: string; domain: string }> = [{ name: "ttwid", value: "t9", domain: ".doubao.com" }];
  let fakeContextClosed = false;
  const fakePage: any = {
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
    getByText: () => ({ first: () => ({ click: async () => undefined }), last: () => ({ click: async () => undefined }) }),
    screenshot: async () => Buffer.from("jpeg"),
    mouse: { click: async () => undefined },
    keyboard: { press: async () => undefined },
    on: () => undefined,
  };
  const fakeContext: any = {
    newPage: async () => fakePage,
    on: () => undefined,
    pages: () => [fakePage],
    cookies: async () => fakeCookies,
    close: async () => { fakeContextClosed = true; },
  };
  const origNewContext = browserTransport.newIsolatedContext;
  (browserTransport as any).newIsolatedContext = async () => fakeContext;
  const { startQrLogin, getQrLogin, screenshotQrLogin, inputQrLogin } = await import("@/lib/qr-login.ts");
  const qr = await startQrLogin({ provider: "doubao", name: "扫码豆包" });
  assert.equal(qr.status, "waiting");
  assert.equal((await screenshotQrLogin(qr.id)).toString(), "jpeg");
  await inputQrLogin(qr.id, { type: "click", x: 100, y: 200 });
  await assert.rejects(() => inputQrLogin(qr.id, { type: "key", key: "Control+W" }), /按键无效/);
  fakeCookies = [...fakeCookies, { name: "sessionid", value: "douyin_sess", domain: ".douyin.com" }];
  await new Promise((r) => setTimeout(r, 1800));
  assert.equal(getQrLogin(qr.id).status, "waiting");
  fakeCookies = [...fakeCookies, { name: "sessionid", value: "db_qr_003", domain: ".doubao.com" }];
  for (let i = 0; i < 30 && getQrLogin(qr.id).status === "waiting"; i++) await new Promise((r) => setTimeout(r, 200));
  for (let i = 0; i < 30 && !getQrLogin(qr.id).account; i++) await new Promise((r) => setTimeout(r, 200));
  const qrDone = getQrLogin(qr.id);
  assert.equal(qrDone.status, "success", qrDone.error || "");
  assert.equal(qrDone.account?.name, "扫码豆包");
  assert.equal(accountPool.getCredential(qrDone.account!.id).credential, "ttwid=t9; sessionid=db_qr_003");
  assert.equal(fakeContextClosed, true);
  accountPool.delete(qrDone.account!.id);
  (browserTransport as any).newIsolatedContext = origNewContext;

  // Mock Doubao upstream HTTP for end-to-end multi-account failover + 2-step confirm + Samantha img2video + clean URL
  const origPost = axios.post.bind(axios);
  let confirmCalled = false;
  let samanthaImg2VideoCalled = false;
  (axios as any).post = async (url: string, data?: any, config?: any) => {
    const cookieHeader = String(config?.headers?.Cookie || "");
    if (url.startsWith("https://www.doubao.com/samantha/pages/upload_image")) {
      assert.equal(config?.headers?.["x-tt-passport-csrf-token"], "csrf2");
      return { status: 200, data: { code: 0, data: { uri: "tos-cn-i-short/frame1.png" } } };
    }
    if (url.startsWith("https://www.doubao.com/alice/message/get_file_url")) {
      return {
        status: 200,
        data: { code: 0, data: { file_urls: [{ uri: "tos-cn-i-full/frame1.png" }] } },
      };
    }
    if (url.startsWith("https://www.doubao.com/samantha/im/conversation/list")) {
      return { status: 200, data: { code: 0, data: { thread_list: [] } } };
    }
    if (url.startsWith("https://www.doubao.com/samantha/chat/completion")) {
      const parsedBody = typeof data === "string" ? JSON.parse(data) : data;
      assert.equal(parsedBody.messages[0].content_type, 2020);
      assert.equal(parsedBody.completion_option.memory_type, 0);
      assert.equal(parsedBody.messages[0].attachments[0].key, "tos-cn-i-full/frame1.png");
      samanthaImg2VideoCalled = true;
      return {
        status: 200,
        data: `data: ${JSON.stringify({
          event_type: 2001,
          event_data: JSON.stringify({ conversation_id: "7488888888888888888", tts_content: "开始生成图生视频" }),
        })}\n\n`,
      };
    }
    if (url.startsWith("https://www.doubao.com/chat/completion")) {
      if (cookieHeader.includes("db_exhausted_001")) {
        return {
          status: 200,
          data: [
            'event: SSE_ACK\ndata: {"ack_client_meta":{"conversation_id":"7411111111111111111","local_conversation_id":"local_1"}}',
            'event: CHUNK_DELTA\ndata: {"text":"抱歉，今日视频免费次数用完，请明日再试"}',
          ].join("\n\n"),
        };
      }
      const parsedBody = typeof data === "string" ? JSON.parse(data) : data;
      const msgText = parsedBody?.messages?.[0]?.content_block?.[0]?.content?.text_block?.text || "";
      if (msgText === "确认") {
        confirmCalled = true;
        assert.equal(parsedBody.option.need_create_conversation, false);
        return {
          status: 200,
          data: 'event: CHUNK_DELTA\ndata: {"text":"视频生成已提交"}',
        };
      }
      return {
        status: 200,
        data: mockAckSse,
      };
    }
    if (url.startsWith("https://www.doubao.com/alice/conversation/latest_messagelist")) {
      assert.equal(data.request_list[0].conversation_id, "7488888888888888888");
      return {
        status: 200,
        data: {
          code: 0,
          data: {
            message_map: {
              "7488888888888888888": [
                {
                  index: 2,
                  content: JSON.stringify([
                    {
                      block_type: 2074,
                      content: JSON.stringify({
                        creations: [
                          {
                            video: {
                              vid: "v0200fg10000clean",
                              video_model: JSON.stringify({
                                fallback_api: mockFallbackApi,
                                video_list: { video_1: { main_url: fallbackB64 } },
                              }),
                            },
                          },
                        ],
                      }),
                    },
                  ]),
                },
              ],
            },
          },
        },
      };
    }
    if (url.startsWith("https://www.doubao.com/creativity/resource/get_without_watermark")) {
      assert.ok(url.includes("vid=v0200fg10000clean"));
      assert.equal(config?.headers?.Referer, "https://www.doubao.com/chat/7488888888888888888");
      return {
        status: 200,
        data: {
          code: 0,
          data: {
            without_watermark: true,
            download_video: { video_1: { download_url: "https://cdn.doubao.com/clean.mp4?lr=unwatermarked" } },
          },
        },
      };
    }
    return origPost(url, data, config);
  };

  const origGet = axios.get.bind(axios);
  const fakeMp4Bytes = Buffer.from("00000018667479706d703432", "hex");
  let fallbackApiCalled = false;
  (axios as any).get = async (url: string, config?: any) => {
    if (url.startsWith("https://vas-lf-x.snssdk.com/video/fplay/1/mock_tok/v0200fg10000clean")) {
      const parsedFUrl = new URL(url);
      assert.equal(parsedFUrl.searchParams.get("channel"), "no");
      assert.equal(parsedFUrl.searchParams.get("codec_type"), "8");
      assert.equal(parsedFUrl.searchParams.get("logo_type"), "unwatermarked");
      fallbackApiCalled = true;
      return {
        status: 200,
        data: {
          video_info: {
            data: {
              video_list: {
                video_1: { main_url: qaabToken, vwidth: 1280, vheight: 720, bitrate: 24700000 },
              },
            },
          },
        },
      };
    }
    if (url === cleanMasterUrl || url === "https://cdn.doubao.com/clean.mp4?lr=unwatermarked") {
      assert.equal(config?.headers?.Referer, "https://www.doubao.com/");
      return { status: 200, data: fakeMp4Bytes };
    }
    return origGet(url, config);
  };

  // Remove jimeng account temporarily to prove Doubao-only pool works on /v1/models and /v1/videos/generations
  accountPool.delete(jmAcc.id);

  // 4. Live HTTP Server Smoke Test
  const server = (await import("@/lib/server.ts")).default;
  const routes = (await import("@/api/routes/index.ts")).default;
  server.attachRoutes(routes);
  await server.listen();
  const baseUrl = `http://127.0.0.1:${testPort}`;

  // Dashboard HTML check
  const htmlRes = await fetch(`${baseUrl}/`);
  assert.equal(htmlRes.status, 200);
  const html = await htmlRes.text();
  assert.ok(html.includes("doubao-seedance-2.0-mini"));
  assert.ok(html.includes("account-provider"));

  // Setup admin + login + create API key
  const setupRes = await fetch(`${baseUrl}/dashboard/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "password123" }),
  });
  assert.equal(setupRes.status, 200);

  const loginRes = await fetch(`${baseUrl}/dashboard/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "password123" }),
  });
  assert.equal(loginRes.status, 200);
  const adminCookie = (loginRes.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(adminCookie.startsWith("session="));

  const keyRes = await fetch(`${baseUrl}/dashboard/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ name: "doubao-cli" }),
  });
  const keyData: any = await keyRes.json();
  assert.ok(keyData.key?.startsWith("jm_"));

  // /v1/models works with Doubao-only account pool
  const modelsRes = await fetch(`${baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${keyData.key}` },
  });
  assert.equal(modelsRes.status, 200);
  const modelsBody: any = await modelsRes.json();
  const modelIds = modelsBody.data.map((m: any) => m.id);
  assert.ok(modelIds.includes("doubao-seedance-2.0-mini"));
  assert.ok(modelIds.includes("doubao-seedance-2.5"));
  assert.ok(modelIds.includes("jimeng-video-seedance-2.5"));

  // /v1/videos/generations fails over from 豆包1号 (quota exhausted) -> 豆包2号 (2-step confirm + clean URL)
  const videoRes = await fetch(`${baseUrl}/v1/videos/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${keyData.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "doubao-seedance-2.0-mini",
      prompt: "海浪拍打礁石，逆光电影感",
      duration: 10,
      ratio: "16:9",
    }),
  });
  assert.equal(videoRes.status, 200);
  const videoBody: any = await videoRes.json();
  const localVideoUrl = String(videoBody.data?.[0]?.url || "");
  assert.ok(localVideoUrl.startsWith(`${baseUrl}/v1/videos/files/doubao_`) && localVideoUrl.endsWith(".mp4"));
  const fileRes = await fetch(localVideoUrl);
  assert.equal(fileRes.status, 200);
  assert.ok((fileRes.headers.get("content-type") || "").includes("video/mp4"));
  assert.equal(fileRes.headers.get("cache-control"), "no-cache");
  assert.ok(fileRes.headers.get("etag"));
  assert.deepEqual(Buffer.from(await fileRes.arrayBuffer()), fakeMp4Bytes);
  assert.equal(fallbackApiCalled, true);
  assert.equal(confirmCalled, true);
  assert.equal(accountPool.get(acc1.id).failureCount, 1);
  assert.ok(accountPool.get(acc1.id).cooldownUntil);
  assert.equal(accountPool.get(acc2.id).successCount, 1);

  // Doubao task persists the conversation id once submitted, and resumes it after a restart without resubmitting
  const { getVideoTask, createVideoTask, updateVideoTask } = await import("@/lib/database.ts");
  const { resumeVideoTasks } = await import("@/api/controllers/video-tasks.ts");
  assert.equal(getVideoTask(videoBody.task_id)?.history_id, "7488888888888888888");
  const doubaoOrphan = createVideoTask({ owner_hash: "o", idempotency_key: null, provider: "doubao", model: "doubao-seedance-2.0-mini", prompt: "p" });
  updateVideoTask(doubaoOrphan.id, { account_id: acc2.id, account_name: "豆包2号", history_id: "7488888888888888888" });
  confirmCalled = false;
  resumeVideoTasks();
  for (let i = 0; i < 30 && getVideoTask(doubaoOrphan.id)?.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(getVideoTask(doubaoOrphan.id)?.status, "succeeded", getVideoTask(doubaoOrphan.id)?.error || "");
  assert.ok(String(getVideoTask(doubaoOrphan.id)?.video_url).includes("/v1/videos/files/doubao_"));
  assert.equal(confirmCalled, false); // polled only, nothing resubmitted

  // 5. Jimeng async task: submit -> idempotent resubmit -> poll -> local file; historyId persisted
  const jmAcc2 = accountPool.create({ name: "即梦2号", provider: "jimeng", sessionId: "jm_session_abc" });
  const jimengVideoUrl = "https://vlabvod.jimengcdn.test/obj/jimeng-out.mp4?sign=1";
  let jimengGenerateCalls = 0;
  const origRequest = axios.request.bind(axios);
  (axios as any).request = async (config: any) => {
    const url = String(config?.url || "");
    if (!url.startsWith("https://jimeng.jianying.com")) return origRequest(config);
    const ok = (data: any) => ({ status: 200, statusText: "OK", data: { ret: "0", errmsg: "", data } });
    if (url.includes("/commerce/v1/benefits/user_credit"))
      return ok({ credit: { gift_credit: 100, purchase_credit: 0, vip_credit: 0 } });
    if (url.includes("/mweb/v1/aigc_draft/generate")) {
      jimengGenerateCalls++;
      assert.equal(config.params.webId, deviceIdentity("jm_session_abc").webId);
      assert.ok(String(config.headers.Cookie).includes("sessionid=jm_session_abc"));
      return ok({ aigc_data: { history_record_id: "hist_42" } });
    }
    if (url.includes("/mweb/v1/get_history_by_ids"))
      return ok({ history_list: [{ status: 50, item_list: [{ video: { play_url: jimengVideoUrl } }] }] });
    return ok({});
  };
  const getBeforeJimeng = (axios as any).get;
  (axios as any).get = async (url: string, config?: any) => {
    if (url === jimengVideoUrl) {
      assert.equal(config?.headers?.Referer, "https://jimeng.jianying.com/");
      return { status: 200, data: fakeMp4Bytes };
    }
    return getBeforeJimeng(url, config);
  };

  const submitAsync = () => fetch(`${baseUrl}/v1/videos/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${keyData.key}`, "Content-Type": "application/json", "Idempotency-Key": "idem-jm-1" },
    body: JSON.stringify({ model: "jimeng-video-seedance-2.0-fast", prompt: "镜头推进", duration: 5, async: true }),
  });
  const asyncRes = await submitAsync();
  assert.equal(asyncRes.status, 200);
  const asyncTask: any = await asyncRes.json();
  assert.ok(String(asyncTask.id).startsWith("vt_"));
  assert.equal(asyncTask.status, "running");
  const dupTask: any = await (await submitAsync()).json();
  assert.equal(dupTask.id, asyncTask.id);

  // Another caller cannot see this task
  const foreignRes = await fetch(`${baseUrl}/v1/videos/generations/${asyncTask.id}`, {
    headers: { Authorization: "Bearer someone-else-token" },
  });
  assert.equal(foreignRes.status, 404);

  let finalTask: any;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    finalTask = await (await fetch(`${baseUrl}/v1/videos/generations/${asyncTask.id}`, {
      headers: { Authorization: `Bearer ${keyData.key}` },
    })).json();
    if (finalTask.status !== "running") break;
  }
  assert.equal(finalTask.status, "succeeded", JSON.stringify(finalTask));
  assert.ok(String(finalTask.url).startsWith(`${baseUrl}/v1/videos/files/jimeng_`));
  assert.equal((await fetch(finalTask.url)).status, 200);
  assert.equal(jimengGenerateCalls, 1);
  assert.equal(getVideoTask(asyncTask.id)?.history_id, "hist_42");
  assert.equal(getVideoTask(asyncTask.id)?.account_id, jmAcc2.id);

  // Restart recovery: submitted jimeng task resumes polling (no resubmit); unsubmitted task is marked failed
  const orphanSubmitted = createVideoTask({ owner_hash: "o", idempotency_key: null, provider: "jimeng", model: "m", prompt: "p" });
  updateVideoTask(orphanSubmitted.id, { account_id: jmAcc2.id, account_name: "即梦2号", history_id: "hist_42" });
  const orphanUnsubmitted = createVideoTask({ owner_hash: "o", idempotency_key: null, provider: "jimeng", model: "m", prompt: "p" });
  resumeVideoTasks();
  assert.equal(getVideoTask(orphanUnsubmitted.id)?.status, "failed");
  for (let i = 0; i < 30 && getVideoTask(orphanSubmitted.id)?.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(getVideoTask(orphanSubmitted.id)?.status, "succeeded");
  assert.equal(jimengGenerateCalls, 1);
  (axios as any).request = origRequest;
  (axios as any).get = getBeforeJimeng;
  accountPool.delete(jmAcc2.id);

  // /dashboard/video-generate works without first_frame (text-to-video on Doubao)
  const form = new FormData();
  form.append("model", "doubao-seedance-2.0-fast");
  form.append("prompt", "雨夜霓虹街道慢镜头");
  form.append("duration", "10");
  form.append("ratio", "21:9");
  const studioRes = await fetch(`${baseUrl}/dashboard/video-generate`, {
    method: "POST",
    headers: { Cookie: adminCookie },
    body: form,
  });
  assert.equal(studioRes.status, 200);
  const studioBody: any = await studioRes.json();
  assert.equal(studioBody.video_url, localVideoUrl);
  assert.equal(studioBody.account_name, "豆包2号");
  assert.equal(studioBody.duration, 10);
  assert.equal(studioBody.ratio, "21:9");

  // Direct generateDoubaoVideo img2video check (base64 reference frame -> upload -> samantha -> poll -> clean URL -> local cache)
  const tinyPngDataUri =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const img2vidUrl = await generateDoubaoVideo(
    "doubao-seedance-2.0-mini",
    "图生视频运镜测试",
    { duration: 5, ratio: "9:16", filePaths: [tinyPngDataUri], pollIntervalMs: 10, baseOrigin: baseUrl },
    "sessionid=db_healthy_002; ttwid=t2; passport_csrf_token=csrf2"
  );
  assert.equal(img2vidUrl, localVideoUrl);
  assert.equal(samanthaImg2VideoCalled, true);

  console.log("ALL DOUBAO SEEDANCE MULTI-ACCOUNT TESTS PASSED");
}

main()
  .then(() => {
    setTimeout(() => {
      try { fs.removeSync(tmpDir); } catch { /* ignore locked wal on windows exit */ }
      process.exit(0);
    }, 100);
  })
  .catch((err) => {
    console.error("TEST FAILED:", err);
    setTimeout(() => {
      try { fs.removeSync(tmpDir); } catch { /* ignore */ }
      process.exit(1);
    }, 100);
  });
