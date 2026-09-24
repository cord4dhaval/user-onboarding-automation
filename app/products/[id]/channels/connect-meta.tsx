"use client";

import { useEffect, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { Button } from "../../../ui/kit";

/** The slice of Meta's SDK this uses. Declared rather than typed globally; nothing else touches it. */
interface FacebookSdk {
  init(options: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(
    callback: (response: { authResponse?: { code?: string } | null }) => void,
    options: { config_id: string; response_type: string; override_default_response_type: boolean; extras: Record<string, unknown> },
  ): void;
}

/** What the flow tells the page as the business moves through it. */
interface SignupEvent {
  type?: string;
  event?: string;
  data?: { phone_number_id?: string; waba_id?: string; current_step?: string; error_message?: string };
}

const SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";

/**
 * Connects a WhatsApp number by signing in, the way Meta intends a product to do it.
 *
 * The alternative is what this replaces: create a Meta app, add the WhatsApp product, make a
 * system user, assign it the app and the account, generate a token that a second admin has
 * to approve, subscribe the app to the account, then find the phone number id by hand. Every
 * one of those is a place to get it wrong, and nobody would ask a customer to do it.
 *
 * Two things arrive separately and both are needed. The ids come through `postMessage` as
 * the flow runs, and the exchangeable code comes back in the callback when it closes — so
 * the ids are kept on a ref rather than in state, because the callback fires with whatever
 * the last render closed over and a state update would not have reached it in time.
 *
 * The code is worth 30 seconds. It goes straight to the server action, which trades it for a
 * token; the browser never sees a credential.
 */
export default function ConnectMeta({
  productId,
  appId,
  configId,
  action,
}: {
  productId: string;
  appId: string;
  /** The Facebook Login for Business configuration. Which one decides whether the flow offers
   *  coexistence — keeping the number in someone's WhatsApp Business app — or a new number. */
  configId: string;
  /** connectMetaWhatsApp. */
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [state, setState] = useState<"idle" | "opening" | "finishing" | "error">("idle");
  const [problem, setProblem] = useState("");
  const assets = useRef<{ wabaId?: string; phoneNumberId?: string }>({});

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!event.origin.endsWith("facebook.com")) return;
      let payload: SignupEvent;
      try {
        payload = (typeof event.data === "string" ? JSON.parse(event.data) : event.data) as SignupEvent;
      } catch {
        return;
      }
      if (payload?.type !== "WA_EMBEDDED_SIGNUP") return;

      if (payload.data?.waba_id) assets.current.wabaId = payload.data.waba_id;
      if (payload.data?.phone_number_id) assets.current.phoneNumberId = payload.data.phone_number_id;
      if (payload.event === "CANCEL") {
        setState("idle");
        setProblem(payload.data?.current_step ? `Stopped at ${payload.data.current_step}.` : "");
      }
      if (payload.event === "ERROR") {
        setState("error");
        setProblem(payload.data?.error_message ?? "Meta reported a problem with the sign-in.");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const open = async () => {
    setProblem("");
    setState("opening");
    try {
      const sdk = await loadSdk(appId);
      sdk.login(
        (response) => {
          const code = response.authResponse?.code;
          const { wabaId, phoneNumberId } = assets.current;
          if (!code || !wabaId || !phoneNumberId) {
            setState(code ? "error" : "idle");
            if (code) setProblem("The sign-in closed before Meta named the account and number.");
            return;
          }
          setState("finishing");
          const form = new FormData();
          form.set("productId", productId);
          form.set("code", code);
          form.set("wabaId", wabaId);
          form.set("phoneNumberId", phoneNumberId);
          void Promise.resolve(action(form)).catch((error: unknown) => {
            setState("error");
            setProblem(error instanceof Error ? error.message : "The connection could not be finished.");
          });
        },
        { config_id: configId, response_type: "code", override_default_response_type: true, extras: { setup: {} } },
      );
    } catch {
      setState("error");
      setProblem("Meta's sign-in script did not load. Check the connection and try again.");
    }
  };

  return (
    <div className="stack">
      <Button variant="primary" icon={<MessageCircle />} onClick={open} disabled={state === "opening" || state === "finishing"}>
        {state === "opening" ? "Opening Meta…" : state === "finishing" ? "Finishing…" : "Connect WhatsApp"}
      </Button>
      {problem ? <p className="muted">{problem}</p> : null}
    </div>
  );
}

/** Loads Meta's SDK once and initialises it, resolving with the same object on later calls. */
function loadSdk(appId: string): Promise<FacebookSdk> {
  const existing = (window as unknown as { FB?: FacebookSdk }).FB;
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_SRC;
    script.async = true;
    script.onload = () => {
      const sdk = (window as unknown as { FB?: FacebookSdk }).FB;
      if (!sdk) return reject(new Error("the SDK loaded without FB"));
      sdk.init({ appId, autoLogAppEvents: true, xfbml: false, version: "v23.0" });
      resolve(sdk);
    };
    script.onerror = () => reject(new Error("the SDK could not be fetched"));
    document.body.appendChild(script);
  });
}
