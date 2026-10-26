export interface ChatActor {
  id: string;
  role: string;
  branches: string[];
}
export interface ChatOwner extends ChatActor { isActive: boolean }
export const managesChat = (user: ChatActor) => user.role === "admin" || user.role === "head";
export const inChatScope = (owner: ChatOwner, user: ChatActor) =>
  owner.isActive && managesChat(owner) && (
    owner.id === user.id || owner.role === "head" ||
    user.branches.some(branch => owner.branches.includes(branch))
  );
export const mayReadChat = (owner: ChatOwner, user: ChatActor, memberIds: string[]) =>
  inChatScope(owner, user) && (owner.id === user.id || memberIds.includes(user.id));
