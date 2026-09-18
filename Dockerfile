FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates chromium ffmpeg git python3 python3-venv xvfb \
    && rm -rf /var/lib/apt/lists/*

ARG YT_SESSION_GENERATOR_COMMIT=8cf81999d924e44da95dd6af996c9ac8598f8c9c
RUN git clone https://github.com/imputnet/yt-session-generator.git /opt/yt-session-generator \
    && git -C /opt/yt-session-generator checkout "$YT_SESSION_GENERATOR_COMMIT" \
    && python3 -m venv /opt/yt-session-venv \
    && /opt/yt-session-venv/bin/pip install --no-cache-dir -r /opt/yt-session-generator/requirements.txt \
    && find /opt/yt-session-venv -path '*/nodriver/core/browser.py' -exec sed -i 's/await self.sleep(0.5)/await self.sleep(2)/' {} \; \
    && rm -rf /opt/yt-session-generator/.git

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY docker ./docker
RUN chmod +x ./docker/start.sh

ENV NODE_ENV=production
EXPOSE 10000

CMD ["./docker/start.sh"]
