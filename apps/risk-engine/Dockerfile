FROM python:3.12-slim

WORKDIR /app

COPY apps/risk-engine/requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY apps/risk-engine/ .

CMD ["python", "-u", "main.py"]
