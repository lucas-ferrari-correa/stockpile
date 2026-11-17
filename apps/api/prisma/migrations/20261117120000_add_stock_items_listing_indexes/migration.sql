CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

DROP INDEX "stock_items_import_id_idx";

CREATE INDEX "stock_items_sku_id_idx" ON "stock_items"("sku", "id");

CREATE INDEX "stock_items_import_id_sku_id_idx" ON "stock_items"("import_id", "sku", "id");

CREATE INDEX "stock_items_name_id_idx" ON "stock_items"("name", "id");

CREATE INDEX "stock_items_import_id_name_id_idx" ON "stock_items"("import_id", "name", "id");

CREATE INDEX "stock_items_category_id_idx" ON "stock_items"("category", "id");

CREATE INDEX "stock_items_import_id_category_id_idx" ON "stock_items"("import_id", "category", "id");

CREATE INDEX "stock_items_warehouse_id_idx" ON "stock_items"("warehouse", "id");

CREATE INDEX "stock_items_import_id_warehouse_id_idx" ON "stock_items"("import_id", "warehouse", "id");

CREATE INDEX "stock_items_quantity_id_idx" ON "stock_items"("quantity", "id");

CREATE INDEX "stock_items_import_id_quantity_id_idx" ON "stock_items"("import_id", "quantity", "id");

CREATE INDEX "stock_items_unit_cost_cents_id_idx" ON "stock_items"("unit_cost_cents", "id");

CREATE INDEX "stock_items_import_id_unit_cost_cents_id_idx" ON "stock_items"("import_id", "unit_cost_cents", "id");

CREATE INDEX "stock_items_unit_price_cents_id_idx" ON "stock_items"("unit_price_cents", "id");

CREATE INDEX "stock_items_import_id_unit_price_cents_id_idx" ON "stock_items"("import_id", "unit_price_cents", "id");

CREATE INDEX "stock_items_margin_id_idx" ON "stock_items"(("unit_price_cents" - "unit_cost_cents"), "id");

CREATE INDEX "stock_items_import_id_margin_id_idx" ON "stock_items"("import_id", ("unit_price_cents" - "unit_cost_cents"), "id");

CREATE INDEX "stock_items_expiration_id_idx" ON "stock_items"("expiration", "id");

CREATE INDEX "stock_items_import_id_expiration_id_idx" ON "stock_items"("import_id", "expiration", "id");

CREATE INDEX "stock_items_expiration_desc_id_idx" ON "stock_items"("expiration" DESC NULLS LAST, "id" DESC);

CREATE INDEX "stock_items_import_id_expiration_desc_id_idx" ON "stock_items"("import_id", "expiration" DESC NULLS LAST, "id" DESC);

CREATE INDEX "stock_items_sku_trgm_idx" ON "stock_items" USING GIN ("sku" public.gin_trgm_ops);

CREATE INDEX "stock_items_name_trgm_idx" ON "stock_items" USING GIN ("name" public.gin_trgm_ops);

CREATE INDEX "stock_items_brand_trgm_idx" ON "stock_items" USING GIN ("brand" public.gin_trgm_ops);

CREATE INDEX "stock_items_supplier_trgm_idx" ON "stock_items" USING GIN ("supplier" public.gin_trgm_ops);

CREATE INDEX "stock_items_lot_trgm_idx" ON "stock_items" USING GIN ("lot" public.gin_trgm_ops);
