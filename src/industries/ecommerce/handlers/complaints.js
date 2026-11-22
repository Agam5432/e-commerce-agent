// Customer care: keeping a problem's context, and raising the complaint (an email to the store with a copy to the customer,
// or a person). Tools: track_issue, raise_complaint. The assistant words every reply itself; what it may say about the
// email or the call comes only from the result of these tools.
import crypto from "node:crypto";
import { escalate, openComplaintForChat, recordIssue } from "../../../services/complaintService.js";

const text = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function complaintHandlers(ctx) {
  const { actions, context, handlers, lang, storeId, userMessage } = ctx;
  const chatRef = () => String(context.chatRef || "");
  // the mail sender, owner address and alert channel: replaced only by tests
  const over = context.complaintDeps || {};
  const verified = () => Boolean(context.customerLoggedIn || context.verifiedCustomerId);

  const issueFrom = (args = {}) => ({
    summary: text(args.summary, 1000),
    originalMessage: text(args.originalMessage, 1500),
    orderNumber: text(args.orderNumber, 40),
    // an order number is "checked" only for a customer who is signed in or verified: otherwise it is what they said
    orderVerified: verified() && Boolean(args.orderNumber),
    productName: text(args.productName, 200),
    attempted: Array.isArray(args.attempted) ? args.attempted : [],
    customerResponse: text(args.customerResponse, 600),
    customerName: text(args.customerName || context.customer?.name, 80),
    customerEmail: text(args.customerEmail || context.customer?.email, 254),
    // one key per customer message, so the same message is counted once (see Complaint.mentions)
    messageKey: userMessage ? crypto.createHash("sha1").update(String(userMessage)).digest("hex").slice(0, 20) : "",
    // the details this reply is about to ask the customer for (the backend remembers them, so none is asked twice)
    askingFor: Array.isArray(args.askingFor) ? args.askingFor : [],
  });

  return {
    // Written down while the assistant works on the problem: this is the memory that stops it asking again.
    track_issue: async (args = {}) => {
      if (!chatRef()) return { status: "unavailable", note: "This chat cannot keep a record of the problem right now. Carry on helping." };
      const issue = issueFrom(args);
      // the customer's own words are kept once: the first time the problem is described
      if (!issue.originalMessage) issue.originalMessage = text(userMessage, 1500);
      // a detail the assistant already asked for once is not asked for again: it is only written down the first time
      const before = issue.askingFor.length ? await openComplaintForChat(storeId, chatRef(), over).catch(() => null) : null;
      const alreadyAsked = issue.askingFor.filter((k) => (before?.asked || []).includes(k) && !(k === "orderNumber" && (before?.orderNumber || issue.orderNumber)));
      issue.askingFor = issue.askingFor.filter((k) => !alreadyAsked.includes(k));
      const { complaint, status } = await recordIssue({ shop: storeId, chatRef: chatRef(), language: lang, settings: context.settings, issue }, over);
      if (status === "unavailable") return { status: "unavailable", note: "The problem could not be written down right now. Carry on helping." };
      if (alreadyAsked.length) {
        return {
          status: "already_asked", reference: complaint?.reference, alreadyAsked,
          known: { summary: complaint?.summary || "", orderNumber: complaint?.orderNumber || "", productName: complaint?.productName || "", alreadyTried: complaint?.attempts || [] },
          note: `You already asked the customer for ${alreadyAsked.join(", ")} earlier in this chat: do NOT ask again and do not insist. Carry on with what you know; a complaint does not need it. If the customer has come back to the problem, offer the complaint now.`,
        };
      }
      return {
        status: "ok",
        reference: complaint?.reference,
        known: { summary: complaint?.summary || "", orderNumber: complaint?.orderNumber || "", productName: complaint?.productName || "", alreadyTried: complaint?.attempts || [] },
        note: "The problem is written down. Do not ask the customer again for anything listed here, and never suggest a step listed under alreadyTried a second time.",
      };
    },

    raise_complaint: async (args = {}) => {
      if (!chatRef()) return { status: "unavailable", note: "A complaint cannot be raised from this chat right now. Offer to connect the customer with a person instead (request_human_support)." };
      const channel = args.channel === "human" ? "human" : args.channel === "email" ? "email" : "";
      // The customer's consent is enforced here, not only asked for in the prompt: the choice (email, or a person) must have been OFFERED
      // in an earlier message of the customer. A call without a channel, or in the same message that offered it, only offers it; the
      // customer answers in their next message, and only then does the complaint go anywhere.
      const key = userMessage ? crypto.createHash("sha1").update(String(userMessage)).digest("hex").slice(0, 20) : "";
      const open = channel ? await openComplaintForChat(storeId, chatRef(), over).catch(() => null) : null;
      if (!channel || !(open?.choiceOfferedKey && open.choiceOfferedKey !== key)) {
        await recordIssue({ shop: storeId, chatRef: chatRef(), language: lang, settings: context.settings, issue: { ...issueFrom(args), originalMessage: text(userMessage, 1500), choiceOfferedKey: key } }, over);
        return { status: "need_choice", note: "Ask ONE question: should the complaint go to the store by email (with a copy to the customer), or does the customer prefer to talk to a person? Nothing was sent or raised: wait for their answer in their NEXT message, then call raise_complaint with the channel they chose." };
      }
      // an email is only sent when the customer said yes to it
      if (channel === "email" && args.customerAgreed !== true) return { status: "need_confirmation", note: "The customer has not agreed to an email yet. Ask once: the complaint can go to the store by email with a copy to them, or they can talk to a person." };
      const issue = issueFrom(args);
      if (!issue.originalMessage) issue.originalMessage = text(userMessage, 1500);
      const out = await escalate({
        shop: storeId, chatRef: chatRef(), channel, issue, reason: text(args.reason, 400),
        customer: { name: issue.customerName, email: issue.customerEmail },
        shopName: context.storeProfile?.storeName || "", settings: context.settings, language: lang,
      }, over);
      const complaint = out.complaint;
      const reference = complaint?.reference;
      if (complaint) actions.push({ type: "complaint_raised", reference, channel: complaint.channel, emailStatus: complaint.email?.status || "none", status: complaint.status });

      if (out.status === "invalid") return { status: "invalid", note: "The complaint could not be raised. Say so honestly." };
      if (out.status === "unavailable") return { status: "unavailable", note: "The complaint could not be saved right now. Do NOT say it was raised. Offer to connect the customer with a person (request_human_support) or to try again in a moment." };

      if (channel === "human") {
        // no email: the person gets the whole complaint, and the customer is not asked to explain again
        const human = await handlers.request_human_support({ reason: text(args.summary || complaint?.summary || args.reason, 240) });
        return {
          status: "person_requested", reference, humanSupport: human, emailSent: false, emailAlreadySent: Boolean(out.emailAlreadySent),
          note: `${out.emailAlreadySent ? "A complaint email had already been sent earlier and cannot be recalled: say so plainly. " : "No email was sent, as the customer wished. "}Say ONE short line, in the customer's language and your own words, that you will try to connect them with a support executive. The chat window now asks about recording and connects them. Do not ask them to explain the complaint again: the person gets it. Do not say a person has joined.`,
        };
      }

      if (out.status === "needs_email") return { status: "needs_email", reference, note: "Ask the customer for the email address a copy should go to. It is the only thing missing; do not ask about the problem again." };
      if (out.status === "already_raised") return { status: "already_raised", reference, email: out.email?.status, note: "The complaint was already raised and its email already went: say so, give the reference, and do not send or promise another one." };
      if (out.status === "ok") {
        return { status: "email_sent", reference, to: "the store's support team", copyTo: complaint.customer?.email, note: "The complaint email was accepted for sending: it went to the STORE'S support team, and a copy went to the customer's own address (copyTo). Say exactly that (the store has it, they have a copy), and give the reference. Do not promise a resolution time." };
      }
      if (out.status === "email_retrying") return { status: "email_retrying", reference, emailSent: false, note: "The email could not be sent right now and will be tried again automatically. Do NOT say it was sent. The complaint is saved. Offer to connect them with a person (request_human_support) or book a callback." };
      // saved, not emailed: failed, or no email set up
      return { status: out.status, reference, emailSent: false, note: "The complaint is saved for the store team but the email was NOT sent. Do NOT say it was sent. Say honestly that it could not be emailed, that it is saved, and offer to connect them with a person now (request_human_support) or book a callback." };
    },
  };
}
