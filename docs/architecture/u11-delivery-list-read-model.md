# U11 delivery list read model

`delivery-list-read.repository.ts` owns the paginated delivery list query, its filter/sort helpers, status summary, and allocation-derived multi-order/multi-affair projections. `livraisons.repository.ts` remains the public compatibility facade and constructs the owner per invocation, preserving the existing pool lookup timing.

The batch deliberately excludes delivery status/detail reads and all delivery writes. Those operations retain header, allocation, lock, upload, event, and transaction responsibilities that do not change with this list projection.
