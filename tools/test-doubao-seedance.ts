import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-seedance-test-"));
const testPort = 18900 + Math.floor(Math.random() * 500);
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.JIMENG_ACCOUNT_POOL_KEY = "unit-test-encryption-key-2026";
process.env.SERVER_PORT = String(testPort);

async function main() {
  const axiosMod = await import("axios");
  const axios = axiosMod.default;
  const APIException = (await import("@/lib/exceptions/APIException.ts")).default;
  const EX = (await import("@/api/consts/exceptions.ts")).default;
  const accountPool = (await import("@/lib/account-pool.ts")).default;
  const {
    executeWithPoolFailover,
    splitAuthCredentials,
  } = await import("@/api/controllers/auth.ts");
  const {
    buildVideoAbilityPayload,
    classifyDoubaoFailure,
    extractCleanVideoUrl,
    extractVideoFromMessages,
    generateDoubaoVideo,
    isDoubaoVideoModel,
    isVideoConfirmCard,
    parseAbilityAck,
    resolveDoubaoCookie,
    resolveLocalVideoPath,
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
  (axios as any).get = async (url: string, config?: any) => {
    if (url === "https://cdn.doubao.com/clean.mp4?lr=unwatermarked") {
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
  assert.deepEqual(Buffer.from(await fileRes.arrayBuffer()), fakeMp4Bytes);
  assert.equal(confirmCalled, true);
  assert.equal(accountPool.get(acc1.id).failureCount, 1);
  assert.ok(accountPool.get(acc1.id).cooldownUntil);
  assert.equal(accountPool.get(acc2.id).successCount, 1);

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
