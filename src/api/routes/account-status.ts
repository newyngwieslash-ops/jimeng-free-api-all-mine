import Request from "@/lib/request/Request.ts";

import { markCredentialFailure, markCredentialSuccess, resolveAuthorization, type ResolvedCredential } from "@/api/controllers/auth.ts";
import { getCredit } from "@/api/controllers/core.ts";
import { getDoubaoAccountStatus } from "@/api/controllers/doubao-videos.ts";
import accountPool, { type AccountProvider } from "@/lib/account-pool.ts";

export default {
  prefix: "/v1/account",
  get: {
    "/status": async (request: Request) => {
      request.validate("headers.authorization", (value) => typeof value === "string");
      const queryProvider = request.query?.provider === "doubao" ? "doubao" : (request.query?.provider === "jimeng" ? "jimeng" : undefined);

      let credential: ResolvedCredential;
      if (queryProvider) {
        credential = await resolveAuthorization(request.headers.authorization, queryProvider);
      } else {
        try {
          credential = await resolveAuthorization(request.headers.authorization, "doubao");
        } catch (err: any) {
          if (String(err?.message).includes("API key")) throw err;
          credential = await resolveAuthorization(request.headers.authorization, "jimeng");
        }
      }

      try {
        if (credential.accountId) {
          const account = await accountPool.refreshStatus(credential.accountId);
          markCredentialSuccess(credential);
          return {
            account: {
              id: account.id,
              name: account.name,
              provider: account.provider,
              enabled: account.enabled,
              status: account.status,
            },
          };
        }

        const provider: AccountProvider = credential.provider || queryProvider || "jimeng";
        if (provider === "doubao") {
          const status = await getDoubaoAccountStatus(credential.token);
          return { account: { provider: "doubao", status } };
        }
        const credits = await getCredit(credential.token);
        return { account: { provider: "jimeng", status: { ...credits, membership: "unknown" } } };
      } catch (error) {
        markCredentialFailure(credential);
        throw error;
      }
    },
  },
};
