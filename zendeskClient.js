import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const subdomain = process.env.ZENDESK_SUBDOMAIN;
const email = process.env.ZENDESK_EMAIL;
const apiToken = process.env.ZENDESK_API_TOKEN;

if (!subdomain || !email || !apiToken) {
  throw new Error("Faltan variables de entorno requeridas: ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN");
}

const baseURL = `https://${subdomain}.zendesk.com/api/v2`;

const zendeskClient = axios.create({
  baseURL,
  auth: {
    username: `${email}/token`,
    password: apiToken
  },
  headers: {
    "Content-Type": "application/json"
  }
});

export default zendeskClient;

