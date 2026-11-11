ALTER TABLE "imports" ADD COLUMN "rejected_by_reason" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "content_sha256" CHAR(64),
ADD COLUMN "forced" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "file_path" TEXT,
ADD COLUMN "created_by_id" UUID NOT NULL;

CREATE UNIQUE INDEX "imports_content_sha256_active_key" ON "imports"("content_sha256") WHERE "status" IN ('pending', 'processing', 'completed') AND "forced" = false;

CREATE INDEX "imports_status_updated_at_idx" ON "imports"("status", "updated_at");

ALTER TABLE "imports" ADD CONSTRAINT "imports_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
