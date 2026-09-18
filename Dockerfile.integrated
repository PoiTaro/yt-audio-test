FROM node:22-bookworm-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NUMBA_DISABLE_JIT=1 \
    LOW_MEMORY_MODE=1 \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    MALLOC_ARENA_MAX=2 \
    PORT=10000 \
    INTERNAL_GATEWAY_HOST=127.0.0.1 \
    INTERNAL_GATEWAY_PORT=10001 \
    INTEGRATED_NODE_GATEWAY_URL=http://127.0.0.1:10001

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv

ENV PATH=/opt/venv/bin:$PATH
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY mr-backend/requirements.txt ./mr-backend/requirements.txt
RUN pip install --no-cache-dir -r mr-backend/requirements.txt

RUN useradd --create-home --uid 10001 appuser
COPY --chown=appuser:appuser src ./src
COPY --chown=appuser:appuser mr-backend ./mr-backend
RUN mkdir -p /app/mr-backend/web_media \
    && chown -R appuser:appuser /app/mr-backend/web_media \
    && chmod 755 /app/src/start-integrated.sh

USER appuser
EXPOSE 10000

CMD ["/app/src/start-integrated.sh"]
