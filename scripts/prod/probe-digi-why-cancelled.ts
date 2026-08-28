/** READ-ONLY. Why were Digi Cofee orders 30/31/32 cancelled? */
import { guard } from './_guard'
async function main(){
  const { db } = guard(['Digi Cofee orders 30/31/32 -> cancellation_reason and timing.'])
  const o = await db.from('orders')
    .select('order_number, cancellation_reason, cancelled_at, payment_status, payment_method, placed_at, updated_at')
    .eq('restaurant_id','ed8bda2b-beb0-4da7-9531-5b597344e6d5').in('order_number',[30,31,32]).order('order_number')
  console.log('\nWHY CANCELLED:', o.error ? JSON.stringify(o.error) : JSON.stringify(o.data,null,2))
}
main().catch(e=>{console.error(e);process.exit(1)})
