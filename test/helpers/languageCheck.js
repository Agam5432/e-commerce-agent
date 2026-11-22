// The agent makes one tiny "is the reply in the shopper's language?" side call after each reply (label: language_check).
// Tests that count the calls of the main conversation use this to tell it apart, so a counted call is a real turn step.
export const isLanguageCheck = (request) => /SAME or DIFFERENT/.test(JSON.stringify(request?.contents ?? request?.messages ?? ""));
