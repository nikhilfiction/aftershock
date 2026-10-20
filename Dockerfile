# Stage 1: build the web app. The output lands in aftershock/web (see ui/vite.config.ts).
FROM node:22-slim AS ui
WORKDIR /app/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui ./
RUN npm run build

# Stage 2: the Python app, which serves the API under /api and the web app at /
FROM python:3.12-slim

# git clones and exports the repositories we scan; Node reads JavaScript/TypeScript and runs their tests
RUN apt-get update && apt-get install -y --no-install-recommends git nodejs npm && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml requirements.txt ./
COPY aftershock ./aftershock
COPY --from=ui /app/aftershock/web ./aftershock/web
RUN pip install --no-cache-dir -r requirements.txt "psycopg[binary]>=3.2" && pip install --no-cache-dir -e .

# the TypeScript compiler the JS/TS scanner uses, installed now instead of on the first scan
ENV AFTERSHOCK_HOME=/opt/aftershock
RUN aftershock setup-js

# run as a normal user, not root
RUN useradd --create-home aftershock && mkdir -p /data && chown aftershock /data
USER aftershock

EXPOSE 8000
CMD ["aftershock", "serve", "--host", "0.0.0.0", "--port", "8000"]
