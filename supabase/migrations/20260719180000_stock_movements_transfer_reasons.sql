-- Workstream 3 (2/3): add transfer_out/transfer_in to stock_movements.reason.
-- Both transfer movements reuse the existing polymorphic reference_type/reference_id --
-- reference_type = 'stock_transfer', reference_id = the transfer's id. No column changes,
-- no touch to goods_received_items/recipe_items/deduct_recipe_stock.
ALTER TABLE "public"."stock_movements" DROP CONSTRAINT "stock_movements_reason_check";
ALTER TABLE "public"."stock_movements" ADD CONSTRAINT "stock_movements_reason_check"
    CHECK ("reason" = ANY (ARRAY['received'::text, 'adjustment'::text, 'loss'::text, 'theft'::text, 'recount'::text, 'sale'::text, 'transfer_out'::text, 'transfer_in'::text]));
