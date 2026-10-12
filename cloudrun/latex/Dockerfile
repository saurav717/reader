# Reader's LaTeX compiler on Cloud Run: all of TeX Live and server.py.
# Deployed by deploy.sh from Cloud Shell, or .github/workflows/deploy-latex-cloudrun.yml (docs/deploy.md).
FROM ghcr.io/xu-cheng/texlive-full:latest

# python3 for the server, git for Overleaf (a paper kept in Drive), and an unprivileged user to run TeX as.
RUN set -e; \
    for tool in python3 git; do command -v $tool >/dev/null || { if command -v apk >/dev/null; then apk add --no-cache $tool; else apt-get update && apt-get install -y --no-install-recommends $tool ca-certificates && rm -rf /var/lib/apt/lists/*; fi; }; done; \
    id tex >/dev/null 2>&1 || adduser -D -H tex 2>/dev/null || useradd --no-create-home --shell /usr/sbin/nologin tex

COPY server.py /srv/server.py
ENV PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python3", "/srv/server.py"]
