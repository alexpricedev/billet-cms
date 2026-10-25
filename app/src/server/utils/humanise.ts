/** A developer's key in an editor's words: `footer.cta` reads "Footer cta". */
export const humanise = (key: string) => {
  const words = key.replace(/[._-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
