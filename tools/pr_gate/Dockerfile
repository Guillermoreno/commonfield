# Build only from this reviewed directory, never from a candidate checkout.
FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openjdk-17-jre-headless && rm -rf /var/lib/apt/lists/*
RUN npm install --global --ignore-scripts @sonar/scan@5.1.0
USER 1000:1000
ENV HOME=/tmp
WORKDIR /candidate
COPY scanner.mjs /opt/scanner.mjs
ENTRYPOINT ["node", "/opt/scanner.mjs"]
