import { customAlphabet } from "nanoid";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const genClusterId = customAlphabet(alphabet, 32);

const proposedIdRegex = new RegExp(`^[${alphabet}]{16,64}$`);

export function newClusterId(): string {
  return genClusterId();
}

export function isValidProposedClusterId(id: string): boolean {
  return proposedIdRegex.test(id);
}
