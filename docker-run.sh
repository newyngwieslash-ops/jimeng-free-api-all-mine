#!/usr/bin/env bash
# 二次开发工作流：改完代码后运行此脚本重建镜像并更新容器
# 用法: bash docker-run.sh [构建标记]   例: bash docker-run.sh true (精简镜像,不含Chromium)
set -e

IMAGE=jimeng-free-api:local
NAME=jimeng-free-api
PORT=8001
VOLUME=jimeng-data
# 账号池加密密钥：一旦设置不可更换，否则旧账号数据无法解密
POOL_KEY=a88d1cd94ae85858147855fb95268d8cbd960b52da71d6dd3e7af34ced563db2
LEAN="${1:-false}"   # 传 true 构建精简镜像（+805MB Chromium 不装，需配合关浏览器传输）

BUILD_ARGS=""
if [ "$LEAN" = "true" ]; then
  BUILD_ARGS="--build-arg INSTALL_BROWSER=false"
  BROWSER_ENV="-e JIMENG_BROWSER_TRANSPORT=off"
fi

echo ">>> 构建镜像 ${IMAGE} ..."
docker build $BUILD_ARGS -t "$IMAGE" .

echo ">>> 移除旧容器 ..."
docker rm -f "$NAME" 2>/dev/null || true

echo ">>> 启动新容器 ..."
# shellcheck disable=SC2086
docker run -it -d --init --name "$NAME" \
  -p ${PORT}:8000 \
  -v ${VOLUME}:/app/data \
  -e TZ=Asia/Shanghai \
  -e JIMENG_ACCOUNT_POOL_KEY=${POOL_KEY} \
  ${BROWSER_ENV} \
  "$IMAGE"

echo ">>> 启动日志："
sleep 3
docker logs "$NAME" 2>&1 | tail -5
echo ""
echo "完成。控制台: http://localhost:${PORT}  日志: docker logs -f ${NAME}"
