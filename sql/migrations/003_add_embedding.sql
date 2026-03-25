-- Phase 5: semantic search — store per-symbol embedding from Python service.
ALTER TABLE symbols
  ADD COLUMN embedding JSON NULL COMMENT 'L2-normalized vector (JSON array of floats)' AFTER usage_count;
