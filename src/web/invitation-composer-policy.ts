export function invitationAddIntent(input: {
  key: string;
  field: "email" | "role";
  composing: boolean;
}): boolean {
  return input.key === "Enter" && input.field === "email" && !input.composing;
}
