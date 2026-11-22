// The industries the agent can work for. Adding one means adding its module here: the agent, the
// dashboard queries and the settings all look an industry up by name.
import ecommerce from "./ecommerce.js";

export const industries = { ecommerce };
export const DEFAULT_INDUSTRY = "ecommerce";
export const industryFor = (name) => industries[name] || industries[DEFAULT_INDUSTRY];