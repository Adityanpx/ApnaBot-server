// The chat text for a location pin the bot sent: "📍 name · address", or "📍 Location"
// when the pin has neither. The pin itself travels as coordinates on the WhatsApp side;
// the chat row keeps only this text (no coordinates are stored).
const locationPinLabel = (location) => {
  const parts = [location?.name, location?.address].filter(Boolean);
  return parts.length > 0 ? `📍 ${parts.join(' · ')}` : '📍 Location';
};

module.exports = { locationPinLabel };
