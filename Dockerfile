FROM node:20-bookworm

# ── System deps ──────────────────────────────────────────────────────────────
# python3 / make / g++ are required to compile node-pty's native bindings.
# curl + jq are used to install the GitHub Copilot CLI binary at build time.
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# ── GitHub Copilot CLI ───────────────────────────────────────────────────────
# The @github/copilot-sdk communicates with the Copilot CLI in server mode.
# We download the latest Linux amd64 binary and place it on PATH as `copilot`.
RUN LATEST=$(curl -fsSL https://api.github.com/repos/github/copilot-cli/releases/latest \
        | jq -r '.tag_name') \
    && curl -fsSL \
        "https://github.com/github/copilot-cli/releases/download/${LATEST}/copilot-linux" \
        -o /usr/local/bin/copilot \
    && chmod +x /usr/local/bin/copilot

# ── App ──────────────────────────────────────────────────────────────────────
WORKDIR /workspace

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

CMD ["npm", "start"]
