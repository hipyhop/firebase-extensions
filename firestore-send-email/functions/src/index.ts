/**
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as admin from "firebase-admin";
import * as functions from "firebase-functions";
import * as nodemailer from "nodemailer";

import * as logs from "./logs";
import config from "./config";
import Templates from "./templates";
import { QueuePayload } from "./types";
import { setSmtpCredentials } from "./helpers";
import * as events from "./events";

logs.init();

let db;
let transport;
let templates;
let initialized = false;

/**
 * Initializes Admin SDK & SMTP connection if not already initialized.
 */
async function initialize() {
  if (initialized === true) return;
  initialized = true;
  admin.initializeApp();
  db = admin.firestore();
  transport = await transportLayer();
  if (config.templatesCollection) {
    templates = new Templates(
      admin.firestore().collection(config.templatesCollection)
    );
  }

  /** setup events */
  events.setupEventChannel();
}

async function transportLayer() {
  if (config.testing) {
    return nodemailer.createTransport({
      host: "localhost",
      port: 8132,
      secure: false,
      tls: {
        rejectUnauthorized: false,
      },
    });
  }

  return setSmtpCredentials(config);
}

function validateFieldArray(field: string, array?: string[]) {
  if (!Array.isArray(array)) {
    throw new Error(`Invalid field "${field}". Expected an array of strings.`);
  }

  if (array.find((item) => typeof item !== "string")) {
    throw new Error(`Invalid field "${field}". Expected an array of strings.`);
  }
}

async function processCreate(snap: FirebaseFirestore.DocumentSnapshot) {
  // Wrapping in transaction to allow for automatic retries (#48)
  return admin.firestore().runTransaction((transaction) => {
    transaction.update(snap.ref, {
      delivery: {
        startTime: admin.firestore.FieldValue.serverTimestamp(),
        state: "PENDING",
        attempts: 0,
        error: null,
      },
    });
    return Promise.resolve();
  });
}

async function preparePayload(payload: QueuePayload): Promise<QueuePayload> {
  const { template } = payload;

  if (templates && template) {
    if (!template.name) {
      throw new Error(`Template object is missing a 'name' parameter.`);
    }

    const templateRender = await templates.render(template.name, template.data);

    const mergeMessage = payload.message || {};

    const attachments = templateRender.attachments
      ? templateRender.attachments
      : mergeMessage.attachments;

    payload.message = Object.assign(mergeMessage, templateRender, {
      attachments: attachments || [],
    });
  }

  let to: string[] = [];
  let cc: string[] = [];
  let bcc: string[] = [];

  if (typeof payload.to === "string") {
    to = [payload.to];
  } else if (payload.to) {
    validateFieldArray("to", payload.to);
    to = to.concat(payload.to);
  }

  if (typeof payload.cc === "string") {
    cc = [payload.cc];
  } else if (payload.cc) {
    validateFieldArray("cc", payload.cc);
    cc = cc.concat(payload.cc);
  }

  if (typeof payload.bcc === "string") {
    bcc = [payload.bcc];
  } else if (payload.bcc) {
    validateFieldArray("bcc", payload.bcc);
    bcc = bcc.concat(payload.bcc);
  }

  if (!payload.toUids && !payload.ccUids && !payload.bccUids) {
    payload.to = to;
    payload.cc = cc;
    payload.bcc = bcc;

    return payload;
  }

  if (!config.usersCollection) {
    throw new Error("Must specify a users collection to send using uids.");
  }

  let uids: string[] = [];

  if (payload.toUids) {
    validateFieldArray("toUids", payload.toUids);
    uids = uids.concat(payload.toUids);
  }

  if (payload.ccUids) {
    validateFieldArray("ccUids", payload.ccUids);
    uids = uids.concat(payload.ccUids);
  }

  if (payload.bccUids) {
    validateFieldArray("bccUids", payload.bccUids);
    uids = uids.concat(payload.bccUids);
  }

  const toFetch = {};
  uids.forEach((uid) => (toFetch[uid] = null));

  const documents = await db.getAll(
    ...Object.keys(toFetch).map((uid) =>
      db.collection(config.usersCollection).doc(uid)
    ),
    {
      fieldMask: ["email"],
    }
  );

  const missingUids = [];

  documents.forEach((documentSnapshot) => {
    if (documentSnapshot.exists) {
      const email = documentSnapshot.get("email");

      if (email) {
        toFetch[documentSnapshot.id] = email;
      } else {
        missingUids.push(documentSnapshot.id);
      }
    } else {
      missingUids.push(documentSnapshot.id);
    }
  });

  logs.missingUids(missingUids);

  if (payload.toUids) {
    payload.toUids.forEach((uid) => {
      const email = toFetch[uid];
      if (email) {
        to.push(email);
      }
    });
  }

  payload.to = to;

  if (payload.ccUids) {
    payload.ccUids.forEach((uid) => {
      const email = toFetch[uid];
      if (email) {
        cc.push(email);
      }
    });
  }

  payload.cc = cc;

  if (payload.bccUids) {
    payload.bccUids.forEach((uid) => {
      const email = toFetch[uid];
      if (email) {
        bcc.push(email);
      }
    });
  }

  payload.bcc = bcc;

  return payload;
}

async function deliver(
  payload: QueuePayload,
  ref: FirebaseFirestore.DocumentReference
): Promise<any> {
  logs.attemptingDelivery(ref);
  const update = {
    "delivery.attempts": admin.firestore.FieldValue.increment(1),
    "delivery.endTime": admin.firestore.FieldValue.serverTimestamp(),
    "delivery.error": null,
    "delivery.leaseExpireTime": null,
  };

  try {
    payload = await preparePayload(payload);

    if (!payload.to.length && !payload.cc.length && !payload.bcc.length) {
      throw new Error(
        "Failed to deliver email. Expected at least 1 recipient."
      );
    }

    const result = await transport.sendMail(
      Object.assign(payload.message, {
        from: payload.from || config.defaultFrom,
        replyTo: payload.replyTo || config.defaultReplyTo,
        to: payload.to,
        cc: payload.cc,
        bcc: payload.bcc,
        headers: payload.headers || {},
      })
    );
    const info = {
      messageId: result.messageId || null,
      accepted: result.accepted || [],
      rejected: result.rejected || [],
      pending: result.pending || [],
      response: result.response || null,
    };

    update["delivery.state"] = "SUCCESS";
    update["delivery.info"] = info;
    logs.delivered(ref, info);
  } catch (e) {
    update["delivery.state"] = "ERROR";
    update["delivery.error"] = e.toString();
    logs.deliveryError(ref, e);
  }

  // Wrapping in transaction to allow for automatic retries (#48)
  return admin.firestore().runTransaction((transaction) => {
    transaction.update(ref, update);
    return Promise.resolve();
  });
}

async function processWrite(change) {
  if (!change.after.exists) {
    return null;
  }

  if (!change.before.exists && change.after.exists) {
    return processCreate(change.after);
  }

  const payload = change.after.data() as QueuePayload;

  if (typeof payload.message !== "object") {
    logs.invalidMessage(payload.message);
  }

  if (!payload.delivery) {
    logs.missingDeliveryField(change.after.ref);
    return null;
  }

  switch (payload.delivery.state) {
    case "SUCCESS":
      await events.recordSuccessEvent(change);
    case "ERROR":
      await events.recordErrorEvent(change, payload, payload.delivery.error);
      return null;
    case "PROCESSING":
      await events.recordProcessingEvent(change);

      if (payload.delivery.leaseExpireTime.toMillis() < Date.now()) {
        const error = "Message processing lease expired.";

        /** Send error event */
        await events.recordErrorEvent(change, payload, error);

        // Wrapping in transaction to allow for automatic retries (#48)
        return admin.firestore().runTransaction((transaction) => {
          transaction.update(change.after.ref, {
            "delivery.state": "ERROR",
            // Keeping error to avoid any breaking changes in the next minor update.
            // Error to be removed for the next major release.
            error,
            "delivery.error": "Message processing lease expired.",
          });

          return Promise.resolve();
        });
      }
      return null;
    case "PENDING":
      await events.recordPendingEvent(change, payload);
    case "RETRY":
      /** Send retry event */
      await events.recordRetryEvent(change, payload);

      // Wrapping in transaction to allow for automatic retries (#48)
      await admin.firestore().runTransaction((transaction) => {
        transaction.update(change.after.ref, {
          "delivery.state": "PROCESSING",
          "delivery.leaseExpireTime": admin.firestore.Timestamp.fromMillis(
            Date.now() + 60000
          ),
        });
        return Promise.resolve();
      });
      return deliver(payload, change.after.ref);
  }
}

export const processQueue = functions.firestore
  .document(config.mailCollection)
  .onWrite(async (change) => {
    await initialize();

    logs.start();

    if (!change.before.exists) {
      await events.recordStartEvent(change);
    }

    try {
      await processWrite(change);
    } catch (err) {
      await events.recordErrorEvent(
        change,
        change.after.data(),
        `Unhandled error occurred during processing: ${err.message}"`
      );
      logs.error(err);
      return null;
    }

    /** record complete event */
    await events.recordCompleteEvent(change);

    logs.complete();
  });
