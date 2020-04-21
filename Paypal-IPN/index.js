'use strict'

// Imports
var querystring = require('querystring')
var http = require('http')

var Mailchimp = require('mailchimp-api-v3')
var bent = require('bent') // A good HTTP client

// Keys and other application settings
var API_KEY = process.env['MAILCHIMP_API_KEY']
var LIST_ID = process.env['MAILCHIMP_LIST_ID']

/**
 * @const {boolean} sandbox Indicates if the sandbox endpoint is used.
 */
const sandbox = Boolean(process.env['PAYPAL_SANDBOX']);

/** Production Postback URL */
const PRODUCTION_VERIFY_URI = 'https://ipnpb.paypal.com/cgi-bin/webscr';
/** Sandbox Postback URL */
const SANDBOX_VERIFY_URI = 'https://ipnpb.sandbox.paypal.com/cgi-bin/webscr';

/**
 * Determine endpoint to post verification data to.
 *
 * @return {String}
 */
function getPaypalURI() {
  return sandbox ? SANDBOX_VERIFY_URI : PRODUCTION_VERIFY_URI;
}

// API setup
var mailchimp = new Mailchimp(API_KEY)
var paypal_verify = bent(getPaypalURI(), 'POST', 'string')

module.exports = async function (context, req) {
    if (req.method !== 'POST') {
        context.log(`Request method not allowed. Was: ${req.method}`)
        context.res.statusCode = 405
        context.res.send(http.STATUS_CODES[context.res.statusCode])
        return
    }
    context.log('PayPal IPN Notification Event received successfully.')

    if (sandbox) {
        context.log('SANDBOX: Using paypal sandbox environment')
    }

    // JSON object of the IPN message consisting of transaction details.
    let ipnTransactionMessage = querystring.parse(req.body);
    // req.body is not parsed by Azure and is urlencoded.
    // Build the body of the verification post message by prefixing 'cmd=_notify-validate'.
    let verificationBody = `cmd=_notify-validate&${req.body}`;

    const verifyResponse = await paypal_verify('/', verificationBody)
    if (verifyResponse === 'VERIFIED') {
        context.log(
            `Verified IPN: IPN message for Transaction ID: ${ipnTransactionMessage.txn_id} is verified.`
        )
    } else if (verifyResponse === 'INVALID') {
        context.log(
            `Invalid IPN: IPN message for Transaction ID: ${ipnTransactionMessage.txn_id} is invalid.`
        )
        context.res.statusCode = 500
        context.res.send(http.STATUS_CODES[context.res.statusCode])
        return
    } else {
        context.log(`Invalid IPN: Unexpected IPN verify response body: ${verifyResponse}`);
        context.res.statusCode = 500
        context.res.send(http.STATUS_CODES[context.res.statusCode])
        return
    }

    if (ipnTransactionMessage.payment_status !== 'Completed') {
        context.log(`IPN: Payment status was not "Completed": ${ipnTransactionMessage.payment_status}`)
        context.res.statusCode = 500
        context.res.send(http.STATUS_CODES[context.res.statusCode])
        return
    }

    if (ipnTransactionMessage.txn_type !== 'web_accept') {
        context.log(`IPN: transaction type was not "web_accept": ${ipnTransactionMessage.txn_type}`)
        context.res.statusCode = 500
        context.res.send(http.STATUS_CODES[context.res.statusCode])
        return
    }

    context.log(`Mailchimp: ${ipnTransactionMessage.payer_email}`)

    var dateNow = new Date(Date.now())
    var dateExpires = new Date(Date.now())
    dateExpires.setFullYear(dateNow.getFullYear() + 5)
    try {
        var result = await mailchimp.post(`/lists/${LIST_ID}/members`, {
            email_address: ipnTransactionMessage.payer_email,
            merge_fields: {
                FNAME: ipnTransactionMessage.first_name,
                LNAME: ipnTransactionMessage.last_name,
                JOINED: dateNow.toISOString(),
                EXPIRES: dateExpires.toISOString()
            },
            status: 'pending'
        })
    } catch (err) {
        if (err.errors) {
            context.log('Mailchimp: errors:', err.errors)
        }

        if (err.message.includes(ipnTransactionMessage.payer_email)) {
            context.log("Mailchimp: signup error:", err.statusCode, err.message)
            context.res.statusCode = err.statusCode || 500
            context.res.send(http.STATUS_CODES[context.res.statusCode])
            return
        } else {
            context.res.statusCode = 500
            throw err
        }
    }
    if (result.statusCode === 200 &&
        (result.status === 'pending' || result.status === 'subscribed')) {
        context.log(`Mailchimp: Successfully subscribed: ${result.email_address}`)

        context.res.statusCode = 200
        context.res.send(http.STATUS_CODES[context.res.statusCode])
    } else {
        context.log('Mailchimp: Unsuccessful result:', result)
        context.res.statusCode = 500
        context.res.send(http.STATUS_CODES[context.res.statusCode])
    }
    context.res.end()
};
