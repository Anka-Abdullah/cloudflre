// Command hmac-fixture reproduces, with Go's own standard library, the exact
// bytes wuzapi signs for every webhook delivery mode, and writes them together
// with the expected `x-hmac-signature` hex value.
//
// The TypeScript verifier in shared/src/lib/hmac.ts is checked against this
// file (shared/test/go-compat.test.ts), which is what proves the Cloudflare
// worker accepts real wuzapi traffic instead of only self-generated payloads.
//
// Regenerate with:
//
//	cd cloudflare/tools/hmac-fixture
//	go mod init fixture >/dev/null 2>&1 || true   # stdlib only, no network
//	go run . ../../shared/test/fixtures/wuzapi-hmac.json
//
// The program only uses the standard library, so it runs without touching the
// (often read-only) Go module cache.
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
)

// Fixture mirrors shared/test/fixtures/wuzapi-hmac.json.
type Fixture struct {
	Name        string `json:"name"`
	Note        string `json:"note"`
	ContentType string `json:"contentType"`
	Key         string `json:"key"`
	Body        string `json:"body"`
	Signature   string `json:"signature"`
}

// signHex mirrors wuzapi's generateHmacSignature: hex(HMAC-SHA256(key, payload)).
func signHex(key string, payload []byte) string {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write(payload)
	return hex.EncodeToString(mac.Sum(nil))
}

func jsonFixture(name, note, key string, payload map[string]interface{}) Fixture {
	// wuzapi signs json.Marshal(body) and resty writes json.Marshal(body)
	// (resty v2 sets JSONMarshal: json.Marshal by default).
	body, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	return Fixture{
		Name:        name,
		Note:        note,
		ContentType: "application/json",
		Key:         key,
		Body:        string(body),
		Signature:   signHex(key, body),
	}
}

func formFixture(name, note, key string, payload map[string]string) Fixture {
	// wuzapi signs formData.Encode(); resty writes r.FormData.Encode()
	// (resty v2.16.5 middleware.go:493), so the signed string *is* the body.
	values := url.Values{}
	for k, v := range payload {
		values.Add(k, v)
	}
	body := values.Encode()
	return Fixture{
		Name:        name,
		Note:        note,
		ContentType: "application/x-www-form-urlencoded",
		Key:         key,
		Body:        body,
		Signature:   signHex(key, []byte(body)),
	}
}

func main() {
	const key = "wuzapi-test-hmac-key-0123456789abcdef"

	// Mirrors the whatsmeow event shape wuzapi forwards for a message, including
	// HTML characters that Go's encoding/json escapes (\u003c, \u003e, \u0026).
	eventJSON := `{"Info":{"Chat":"6281234567890@s.whatsapp.net","ID":"3EB0ABCDEF","IsFromMe":false,"PushName":"Pelanggan & Co","Timestamp":"2026-10-10T07:15:00Z"},"Message":{"conversation":"Halo <admin> \"tes\" & terima kasih\nbaris dua"}}`
	// wuzapi puts `type` next to `event` before handing the map to the webhook:
	// postmap {"type": ..., "event": ...} is what jsonData always contains.
	postmapJSON := `{"type":"Message","event":` + eventJSON + `}`

	fixtures := []Fixture{
		jsonFixture(
			"json-event-message",
			"Per-user webhook, WEBHOOK_FORMAT=json: body is json.Marshal of the event map resty sends verbatim.",
			key,
			map[string]interface{}{
				"type":         "Message",
				"event":        json.RawMessage(eventJSON),
				"userID":       "1",
				"instanceName": "nomor-1",
			},
		),
		jsonFixture(
			"json-global-webhook",
			"Global webhook (WUZAPI_GLOBAL_WEBHOOK) in JSON mode: jsonData stays a nested JSON string.",
			key,
			map[string]interface{}{
				"jsonData":     postmapJSON,
				"userID":       "1",
				"instanceName": "nomor-1",
			},
		),
		jsonFixture(
			"json-event-unicode",
			"Unicode, newlines and HTML characters must survive Go's default HTML escaping byte-for-byte.",
			key,
			map[string]interface{}{
				"type": "Message",
				"event": map[string]interface{}{
					"Message": map[string]interface{}{"conversation": "emoji \U0001F600 <b> & </b> \u00e9\u00e8 \t tab"},
				},
				"userID":       "1",
				"instanceName": "nomor-\u00e9",
			},
		),
		formFixture(
			"form-event-message",
			"Per-user webhook, default (form) mode: url.Values.Encode() output is both the signed string and the body.",
			key,
			map[string]string{
				"jsonData":     postmapJSON,
				"userID":       "1",
				"instanceName": "nomor-1",
			},
		),
		formFixture(
			"form-special-characters",
			"Go query escaping: space becomes '+', '*' becomes %2A, '~' stays literal, unicode is percent-encoded.",
			key,
			map[string]string{
				"jsonData":     `{"type":"Message","event":{"Message":{"conversation":"a b + c & d = e * f ~ g \u00e9"}}}`,
				"userID":       "1",
				"instanceName": "nomor satu",
			},
		),
		mediaJSONFixture(key),
		mediaFormFixture(key),
	}

	out := os.Stdout
	if len(os.Args) > 1 {
		file, err := os.Create(os.Args[1])
		if err != nil {
			fmt.Fprintln(os.Stderr, "create:", err)
			os.Exit(1)
		}
		defer file.Close()
		out = file
	}

	encoder := json.NewEncoder(out)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(map[string]interface{}{
		"generator": "cloudflare/tools/hmac-fixture",
		"fixtures":  fixtures,
	}); err != nil {
		fmt.Fprintln(os.Stderr, "encode:", err)
		os.Exit(1)
	}
}

// mediaJSONFixture mirrors wuzapi's media path with WEBHOOK_FORMAT=json: the
// body is built by writeMediaJSON (base64 streamed inline) and signed over the
// raw stream (media_delivery.go deliverMediaHook -> mediaSignature).
func mediaJSONFixture(key string) Fixture {
	payload := []byte("media-bytes-for-fixture-\x00\x01\x02")
	file := map[string]interface{}{
		"base64": base64.StdEncoding.EncodeToString(payload),
		"event": map[string]interface{}{
			"Info":    map[string]interface{}{"Chat": "6281234567890@s.whatsapp.net", "ID": "3EB0MEDIA"},
			"Message": map[string]interface{}{"imageMessage": map[string]interface{}{"mimetype": "image/jpeg"}},
		},
		"fileName":     "IMG-0001.jpg",
		"mimeType":     "image/jpeg",
		"type":         "Message",
		"instanceName": "nomor-1",
		"userID":       "1",
	}
	body, err := json.Marshal(file)
	if err != nil {
		panic(err)
	}
	return Fixture{
		Name:        "media-json-inline-base64",
		Note:        "Media event in JSON mode: base64 is streamed inline and the signature covers the raw body stream.",
		ContentType: "application/json",
		Key:         key,
		Body:        string(body),
		Signature:   signHex(key, body),
	}
}

// mediaFormFixture mirrors prepareMediaForm (wuzapi media_json.go): the body is
// `instanceName=<esc>&jsonData=<escaped media json>&userID=<esc>` where the
// jsonData value is escaped byte-wise like Go's url.QueryEscape, and the
// signature covers that raw body.
func mediaFormFixture(key string) Fixture {
	payload := []byte("media-bytes-for-fixture-\x00\x01\x02")
	eventJSON, err := json.Marshal(map[string]interface{}{
		"base64":   base64.StdEncoding.EncodeToString(payload),
		"fileName": "IMG-0001.jpg",
		"mimeType": "image/jpeg",
		"type":     "Message",
		"event": map[string]interface{}{
			"Info":    map[string]interface{}{"Chat": "6281234567890@s.whatsapp.net", "ID": "3EB0MEDIA"},
			"Message": map[string]interface{}{"imageMessage": map[string]interface{}{"mimetype": "image/jpeg"}},
		},
	})
	if err != nil {
		panic(err)
	}
	body := "instanceName=" + url.QueryEscape("nomor-1") +
		"&jsonData=" + formEscape(string(eventJSON)) +
		"&userID=" + url.QueryEscape("1")

	return Fixture{
		Name:        "media-form-with-file",
		Note:        "Media event in form mode: jsonData carries the media JSON escaped inline and the signature covers the raw body.",
		ContentType: "application/x-www-form-urlencoded",
		Key:         key,
		Body:        body,
		Signature:   signHex(key, []byte(body)),
	}
}

// formEscape mirrors wuzapi's formEscapeWriter (media_json.go): unlike
// url.QueryEscape it escapes '*' as well and keeps '~' literal, byte-wise.
func formEscape(s string) string {
	const hexDigits = "0123456789ABCDEF"
	var out strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '~':
			out.WriteByte(c)
		case c == ' ':
			out.WriteByte('+')
		default:
			out.WriteByte('%')
			out.WriteByte(hexDigits[c>>4])
			out.WriteByte(hexDigits[c&15])
		}
	}
	return out.String()
}
