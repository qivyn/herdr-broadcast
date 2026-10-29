FROM node:24-bookworm-slim

ARG CLAUDE_VERSION=2.1.309
ARG PI_VERSION=1.4.0
ARG CC_SWITCH_VERSION=5.11.3
ARG TARGETARCH

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash ca-certificates curl git jq openssh-client procps python3 ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && npm install --global "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
    && npm cache clean --force

RUN case "${TARGETARCH}" in \
        arm64) cc_arch=arm64 ;; \
        amd64) cc_arch=x64 ;; \
        *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl --fail --location --retry 3 \
        "https://github.com/SaladDay/cc-switch-cli/releases/download/v${CC_SWITCH_VERSION}/cc-switch-cli-linux-${cc_arch}-musl.tar.gz" \
        --output /tmp/cc-switch.tar.gz \
    && tar -xzf /tmp/cc-switch.tar.gz -C /tmp cc-switch \
    && install -m 0755 /tmp/cc-switch /usr/local/bin/cc-switch \
    && rm /tmp/cc-switch /tmp/cc-switch.tar.gz

ENV HOME=/home/node \
    LANG=C.UTF-8 \
    TERM=xterm-256color \
    COLORTERM=truecolor \
    DISABLE_AUTOUPDATER=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
ENV PATH="/home/node/.local/bin:${PATH}"

RUN mkdir -p /workspace /home/node/.claude /home/node/.pi/agent /home/node/.cc-switch \
    && chown -R node:node /workspace /home/node

USER node
WORKDIR /workspace

RUN claude --version && pi --version && cc-switch --version

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \
    && mkdir -p /run/sshd /etc/ssh/keys \
    && passwd -d node \
    && printf '%s\n' 'DISABLE_AUTOUPDATER=1' 'LANG=C.UTF-8' >> /etc/environment

COPY sshd_config /etc/ssh/sshd_config
COPY start-sshd.sh /usr/local/bin/start-sshd
RUN chmod 0755 /usr/local/bin/start-sshd

EXPOSE 22
CMD ["/usr/local/bin/start-sshd"]
