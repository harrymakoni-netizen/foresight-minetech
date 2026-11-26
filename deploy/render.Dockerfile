# Foresight engine service for Render: simulation engines + messaging service.
# Node dependencies are installed on the same Debian release (bookworm) as the
# Python runtime so native modules (better-sqlite3) match.
# Full (non-slim) image: includes python3/make/g++ in case better-sqlite3 has
# no prebuilt binary to download and must compile.
FROM node:22-bookworm AS node
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts=false

FROM python:3.13-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# rasterio's bundled GDAL needs libexpat, which the slim Python image lacks. Taken
# from the (same Debian release) build stage so no apt access is needed.
COPY --from=node /usr/lib/x86_64-linux-gnu/libexpat.so.1* /usr/lib/x86_64-linux-gnu/
WORKDIR /app
COPY deploy/requirements-engine.txt deploy/requirements-engine.txt
RUN pip install --no-cache-dir --no-deps jupedsim==1.4.2 \
 && pip install --no-cache-dir -r deploy/requirements-engine.txt
COPY --from=node /app/node_modules node_modules
COPY package.json ./
COPY lib lib
COPY services services
COPY migrations migrations
COPY certificates certificates
COPY deploy/render-start.sh deploy/render-start.sh
ENV NODE_ENV=production FORESIGHT_ENV=production MESSAGING_MODE=dry-run PYTHONUNBUFFERED=1 MPLBACKEND=Agg
RUN useradd --create-home foresight
USER foresight
CMD ["sh", "deploy/render-start.sh"]
