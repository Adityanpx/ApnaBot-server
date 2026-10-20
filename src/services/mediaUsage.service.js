const supabase = require('../config/supabase');

// The ONE answer to "where is this library file used?". GET /api/business/media/:id/usage returns it and
// businessMedia.service.js#deleteBusinessMedia refuses on it, so "usage says unused" and "DELETE allowed"
// can never disagree. (The storage sweeper has its own all-businesses scan, storageInventory.service.js,
// built for purging orphans; it must stay in step with the kinds below.)
//
// usedBy items: { kind, nodeId?, id?, label, cardIndex? }
//   reply_image      flow_nodes.media_id (photo #1 of a reply)       nodeId, label = keyword || label
//   gallery          flow_nodes.gallery_media_ids (photos #2..N)     nodeId, label
//   video            flow_nodes.video_media_id                       nodeId, label
//   carousel_card    flow_nodes.carousel_cards[].media_id            nodeId, label, cardIndex (1-based, as shown)
//   template_header  message_templates.header_media_id               id, label = template name
//   course           business_courses.image_media_id                 id, label = course name
//   vehicle          vehicles.custom_photo_url = the file's url      id, label = vehicle name
//   catalog_cover    catalog_collections.cover_media_id              id, label = collection title
//   catalog_item     catalog_items.media_id                          id, collectionId, label = design no (else "Photo")

const must = ({ data, error }) => {
  if (error) throw error;
  return data || [];
};

const nodeLabel = (n) => n.keyword || n.label || n.id;

/**
 * @param {string} businessId
 * @param {string} mediaId
 * @returns {Promise<{ found: boolean, inUse: boolean, usedBy: Object[], fileSizeBytes: number|null }>}
 *   found = false when the id is not a media row of this business (the caller decides the status).
 */
const getMediaUsage = async (businessId, mediaId) => {
  const { data: media, error: mediaErr } = await supabase
    .from('business_media').select('id, url, file_size_bytes').eq('id', mediaId).eq('business_id', businessId).maybeSingle();
  if (mediaErr) throw mediaErr;
  if (!media) return { found: false, inUse: false, usedBy: [], fileSizeBytes: null };

  const [mainRefs, galleryRefs, videoRefs, carouselNodes, templates, courses, vehicles, catalogCovers, catalogItems] = (await Promise.all([
    supabase.from('flow_nodes').select('id, label, keyword').eq('business_id', businessId).eq('media_id', mediaId),
    supabase.from('flow_nodes').select('id, label, keyword').eq('business_id', businessId).contains('gallery_media_ids', [mediaId]),
    supabase.from('flow_nodes').select('id, label, keyword').eq('business_id', businessId).eq('video_media_id', mediaId),
    // carousel_cards is an array of objects: PostgREST can't contain-match inside it portably, and a
    // business has few carousel nodes, so filter here.
    supabase.from('flow_nodes').select('id, label, keyword, carousel_cards').eq('business_id', businessId).not('carousel_cards', 'is', null),
    supabase.from('message_templates').select('id, name').eq('business_id', businessId).eq('header_media_id', mediaId),
    supabase.from('business_courses').select('id, name').eq('business_id', businessId).eq('image_media_id', mediaId),
    media.url
      ? supabase.from('vehicles').select('id, custom_name').eq('business_id', businessId).eq('custom_photo_url', media.url)
      : Promise.resolve({ data: [], error: null }),
    supabase.from('catalog_collections').select('id, title').eq('business_id', businessId).eq('cover_media_id', mediaId),
    supabase.from('catalog_items').select('id, collection_id, design_no').eq('business_id', businessId).eq('media_id', mediaId)
  ])).map(must);

  const usedBy = [
    ...mainRefs.map(n => ({ kind: 'reply_image', nodeId: n.id, label: nodeLabel(n) })),
    ...galleryRefs.map(n => ({ kind: 'gallery', nodeId: n.id, label: nodeLabel(n) })),
    ...videoRefs.map(n => ({ kind: 'video', nodeId: n.id, label: nodeLabel(n) })),
    ...carouselNodes.flatMap(n => (Array.isArray(n.carousel_cards) ? n.carousel_cards : [])
      .map((card, i) => (card && card.media_id === mediaId ? { kind: 'carousel_card', nodeId: n.id, label: nodeLabel(n), cardIndex: i + 1 } : null))
      .filter(Boolean)),
    ...templates.map(t => ({ kind: 'template_header', id: t.id, label: t.name })),
    ...courses.map(c => ({ kind: 'course', id: c.id, label: c.name })),
    ...vehicles.map(v => ({ kind: 'vehicle', id: v.id, label: v.custom_name || v.id })),
    ...catalogCovers.map(c => ({ kind: 'catalog_cover', id: c.id, label: c.title })),
    ...catalogItems.map(i => ({ kind: 'catalog_item', id: i.id, collectionId: i.collection_id, label: i.design_no || 'Photo' }))
  ];

  return { found: true, inUse: usedBy.length > 0, usedBy, fileSizeBytes: Number(media.file_size_bytes) };
};

const unique = (list) => [...new Set(list)];

/**
 * The message DELETE answers with when the file is in use: one sentence for the first kind of use, in the
 * order the endpoint always checked them (replies, carousels, templates), then courses and vehicles.
 */
const describeUsage = (usedBy) => {
  const of = (...kinds) => usedBy.filter(u => kinds.includes(u.kind));
  const replies = of('reply_image', 'gallery', 'video');
  if (replies.length > 0) {
    const names = unique(replies.map(u => u.label)).join(', ');
    return `Used by: ${names} — remove it from those replies first.`;
  }
  const cards = of('carousel_card');
  if (cards.length > 0) {
    const names = cards.map(u => `${u.label} card ${u.cardIndex}`).join(', ');
    return `Used by carousel: ${names} — remove it from those cards first.`;
  }
  const templates = of('template_header');
  if (templates.length > 0) {
    return `Used as the header of template: ${unique(templates.map(u => u.label)).join(', ')} — attach other media to it first.`;
  }
  const courses = of('course');
  if (courses.length > 0) {
    return `Used as the photo of course: ${unique(courses.map(u => u.label)).join(', ')} — change the course photo first.`;
  }
  const vehicles = of('vehicle');
  if (vehicles.length > 0) {
    return `Used as the photo of vehicle: ${unique(vehicles.map(u => u.label)).join(', ')} — change the vehicle photo first.`;
  }
  const covers = of('catalog_cover');
  if (covers.length > 0) {
    return `Used as the cover of catalogue collection: ${unique(covers.map(u => u.label)).join(', ')} — change the cover first.`;
  }
  return `Used in the Catalogue (${of('catalog_item').length} photo${of('catalog_item').length === 1 ? '' : 's'}) — remove it from the Catalogue first.`;
};

module.exports = { getMediaUsage, describeUsage };
