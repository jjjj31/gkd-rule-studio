ARG PYTHON_IMAGE=python:3.12.16-slim-bookworm
FROM ${PYTHON_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FEEDBACK_DATA_DIR=/data

WORKDIR /app

RUN groupadd --system feedback \
    && useradd --system --gid feedback --home-dir /app feedback \
    && mkdir -p /data \
    && chown feedback:feedback /data

COPY requirements.txt .
RUN python -m pip install --no-cache-dir --requirement requirements.txt

COPY app ./app

USER feedback
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--no-server-header"]

