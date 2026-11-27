// The legacy shared preview no longer provides an authentication bypass.
// Its original implementation remains in Git history; new sessions use Better Auth.
export async function identity():Promise<{owner:string;actor:string}|null>{return null;}
