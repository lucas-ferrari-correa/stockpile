ALTER TABLE "imports" ADD COLUMN "item_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "items_created" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "items_updated" INTEGER NOT NULL DEFAULT 0;

UPDATE "imports"
SET "item_count" = counted.total
FROM (
    SELECT "import_id", count(*)::INTEGER AS total
    FROM "stock_items"
    GROUP BY "import_id"
) AS counted
WHERE "imports"."id" = counted."import_id";

CREATE UNLOGGED TABLE "import_staged_rows" (
    "import_id" UUID NOT NULL,
    "line" INTEGER NOT NULL,
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

    CONSTRAINT "import_staged_rows_pkey" PRIMARY KEY ("import_id","line")
);

ALTER TABLE "import_staged_rows" ADD CONSTRAINT "import_staged_rows_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
