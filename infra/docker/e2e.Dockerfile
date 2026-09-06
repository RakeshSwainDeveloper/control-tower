# Playwright ships its own image with the browsers already installed and the
# right system libraries. Building our own would mean tracking Chromium's
# dependency list by hand, forever.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /work
