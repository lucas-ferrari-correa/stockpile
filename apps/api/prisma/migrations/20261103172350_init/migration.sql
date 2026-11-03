CREATE TYPE "import_status" AS ENUM ('pending', 'processing', 'completed', 'failed');

CREATE TABLE "imports" (
    "id" UUID NOT NULL,
    "status" "import_status" NOT NULL DEFAULT 'pending',
    "file_name" TEXT NOT NULL,
    "total_rows" INTEGER,
    "processed_rows" INTEGER NOT NULL DEFAULT 0,
    "accepted_rows" INTEGER NOT NULL DEFAULT 0,
    "rejected_rows" INTEGER NOT NULL DEFAULT 0,
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "imports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "exchange_rate_snapshots" (
    "id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "base" TEXT NOT NULL,
    "rate_date" DATE NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL,
    "source" TEXT NOT NULL,
    "rates" JSONB NOT NULL,

    CONSTRAINT "exchange_rate_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stock_items" (
    "id" SERIAL NOT NULL,
    "import_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "brand" TEXT,
    "supplier" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "warehouse" TEXT NOT NULL,
    "lot" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_cost_cents" INTEGER NOT NULL,
    "unit_price_cents" INTEGER NOT NULL,
    "expiration" DATE,

    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "import_errors" (
    "id" SERIAL NOT NULL,
    "import_id" UUID NOT NULL,
    "line" INTEGER NOT NULL,
    "field" TEXT,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "raw" TEXT NOT NULL,

    CONSTRAINT "import_errors_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "imports_created_at_idx" ON "imports"("created_at" DESC);

CREATE UNIQUE INDEX "exchange_rate_snapshots_import_id_key" ON "exchange_rate_snapshots"("import_id");

CREATE INDEX "stock_items_import_id_idx" ON "stock_items"("import_id");

CREATE UNIQUE INDEX "stock_items_sku_warehouse_lot_key" ON "stock_items"("sku", "warehouse", "lot");

CREATE INDEX "import_errors_import_id_line_idx" ON "import_errors"("import_id", "line");

ALTER TABLE "exchange_rate_snapshots" ADD CONSTRAINT "exchange_rate_snapshots_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "import_errors" ADD CONSTRAINT "import_errors_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
