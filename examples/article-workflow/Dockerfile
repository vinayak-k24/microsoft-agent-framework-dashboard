FROM python:3.12-slim-trixie@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libltdl7 libkrb5-3 libgssapi-krb5-2 \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY agent.py main.py tools.py ./
RUN useradd --create-home --uid 10001 agent
USER agent
EXPOSE 8088
CMD ["python", "main.py"]
