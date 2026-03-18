FROM python:3.12-slim
WORKDIR /app
COPY apps/search-indexer/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/search-indexer/main.py .
CMD ["python", "-u", "main.py"]
