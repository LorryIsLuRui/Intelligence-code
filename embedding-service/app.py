"""
Phase 5：本地句向量服务，供 Node 索引与 semantic search 调用。
默认模型 all-MiniLM-L6-v2（384 维，首次启动会下载权重）。
"""

from __future__ import annotations

import os
from typing import Any, Optional

from fastapi import FastAPI
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

app = FastAPI(title="code-intelligence-embeddings", version="0.1.0")

_model: Optional[SentenceTransformer] = None


def get_model() -> SentenceTransformer:
    global _model
    if _model is None:
        name = os.environ.get("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
        _model = SentenceTransformer(name)
    return _model


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=0, description="Batch of strings to embed")


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    dim: int


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True}


@app.post("/embed", response_model=EmbedResponse)
def embed(body: EmbedRequest) -> EmbedResponse:
    if not body.texts:
        return EmbedResponse(embeddings=[], dim=0)
    model = get_model()
    vectors = model.encode(
        body.texts,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    rows = vectors.tolist()
    dim = len(rows[0]) if rows else 0
    return EmbedResponse(embeddings=rows, dim=dim)
