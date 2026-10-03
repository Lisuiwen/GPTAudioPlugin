export type AuthSession = {
  profileId: string;
  username: string;
  name?: string;
  replicateToken: string;
  scope: string[];
};
