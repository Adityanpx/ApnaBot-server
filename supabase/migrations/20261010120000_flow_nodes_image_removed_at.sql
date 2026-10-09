-- flow_nodes.image_removed_at: when the storage sweeper (storageCleanupSweeper.service.js)
-- removed a bot node's image (image_url / media_id set to NULL), so the Bot Builder can say
-- "image removed by storage cleanup" instead of a silently empty picture.
--
--   set     by the sweeper, in the same update that nulls image_url
--   cleared whenever a new image is set on the node (flowGraph.controller.js single-node
--           PUTs; flowGraph.service.js#saveFullGraph for the canvas batch save)
--   read    GET /api/flow-graph/* returns it as imageRemovedAt (select('*') + toCamelCase)
--
-- save_flow_graph_full's UPDATE SET does NOT list this column on purpose: its payload never
-- carries it, so adding it there would NULL it on every canvas save. flow_snapshots store
-- nodes as jsonb and are not given this field.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same commit (the sweeper
-- update and every node image write name the column).

alter table flow_nodes add column if not exists image_removed_at timestamptz;
