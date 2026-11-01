// A stand-in for SG Travels' flow as it stood on 2026-11-01 (read from production, trimmed): a 3-button main
// menu, the Rates reply, Contact, the web-form "book" reply, the orphan vehicleType question and the Catalogue
// reply with the paused carousel reply the Catalogue's "Replace" left behind (same keyword). Test data
// only - never written anywhere. Rows are snake_case, as flow_nodes / flow_edges return them.
const SG = 'a94aec66-23fb-43e1-afcc-f4e8d518134b';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const reply = (n, keyword, over = {}) => ({
  id: id(n), business_id: SG, node_type: 'reply', keyword, match_type: 'contains', hindi_aliases: [], reply_kind: 'text',
  trigger_count: 3, content_type: 'text', label: `Reply ${keyword}`, label_translations: null, field_key: null, options: [],
  is_computed: false, is_active: true, required: false, position_x: 10, position_y: 20, ...over
});

const HI = id(1); const RATES = id(2); const CONTACT = id(3); const BOOK = id(4); const VEHICLE_TYPE = id(5);
const CATALOGUE = id(6); const OLD_CAROUSEL = id(7); const SHIRTS = id(8);

const nodes = () => [
  reply(1, 'hi', { match_type: 'exact', content_type: 'buttons', label: 'Hi *{{customerName}}*, welcome' }),
  reply(2, 'rates', { content_type: 'buttons', label: 'We offer One Way, Round Trip, and Local rentals' }),
  reply(3, 'contactinfo', { content_type: 'buttons', label: 'You can reach us anytime' }),
  reply(4, 'book', { reply_kind: 'web_form_trigger', label: "Great! Let's get your ride booked." }),
  {
    id: VEHICLE_TYPE, business_id: SG, node_type: 'question', keyword: null, field_key: 'vehicleType', content_type: 'list',
    label: 'Which vehicle would you prefer?', options: [{ value: 'Sedan', label: 'Sedan' }, { value: 'SUV', label: 'SUV' }],
    required: true, is_computed: false, is_active: true, hindi_aliases: [], trigger_count: 0, position_x: null, position_y: null
  },
  // The active Catalogue reply, and the older carousel reply with the same keyword, paused by the Catalogue's "Replace".
  reply(6, 'catalogue', { content_type: 'catalog', label: 'Here is our catalogue', trigger_count: 1 }),
  reply(7, 'catalogue', { match_type: 'exact', content_type: 'text', label: 'Our new collection', is_active: false, trigger_count: 2 }),
  reply(8, 'shirt-designs', { label: 'You opened SHIRTS' })
];
const edge = (n, from, to, label, order) => ({
  id: id(100 + n), business_id: SG, from_node_id: from, to_node_id: to, label, label_translations: null, description: null,
  description_translations: null, condition: null, preset: null, display_order: order, card_index: null
});
const edges = () => [
  edge(1, HI, BOOK, 'Book a ride', 0),
  edge(2, HI, RATES, 'Our Rates', 1),
  edge(3, HI, CONTACT, 'Contact Us', 2),
  edge(4, RATES, BOOK, 'Book a ride', 0),
  edge(5, CONTACT, BOOK, 'Book a ride', 0),
  edge(6, OLD_CAROUSEL, SHIRTS, 'View designs', 0)
];

module.exports = { SG, HI, RATES, CONTACT, BOOK, VEHICLE_TYPE, CATALOGUE, OLD_CAROUSEL, SHIRTS, nodes, edges };
