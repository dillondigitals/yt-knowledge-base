// Deploy this as a Google Apps Script Web App
// 1. Go to https://script.google.com
// 2. Create new project, paste this code
// 3. Deploy > New deployment > Web app
// 4. Execute as: Me, Who has access: Anyone
// 5. Copy the URL and set it as NEXT_PUBLIC_CAPTION_PROXY in .env.local

function doGet(e) {
  var videoId = e.parameter.v;
  var lang = e.parameter.lang || "en";
  var kind = e.parameter.kind || "";

  if (!videoId) {
    return ContentService.createTextOutput(
      JSON.stringify({ error: "Missing video ID" })
    ).setMimeType(ContentService.MimeType.JSON);
  }

  // Try JSON3 format first
  var formats = ["json3", ""];
  var kinds = kind ? [kind, "asr", ""] : ["asr", ""];

  for (var k = 0; k < kinds.length; k++) {
    for (var f = 0; f < formats.length; f++) {
      var url =
        "https://www.youtube.com/api/timedtext?v=" +
        videoId +
        "&lang=" +
        lang;
      if (kinds[k]) url += "&kind=" + kinds[k];
      if (formats[f]) url += "&fmt=" + formats[f];

      try {
        var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
        var code = response.getResponseCode();
        var body = response.getContentText();

        if (code === 200 && body.length > 50) {
          return ContentService.createTextOutput(
            JSON.stringify({
              transcript: body,
              format: formats[f] || "xml",
              lang: lang,
              kind: kinds[k],
            })
          ).setMimeType(ContentService.MimeType.JSON);
        }
      } catch (e) {
        continue;
      }
    }
  }

  return ContentService.createTextOutput(
    JSON.stringify({ error: "No captions available" })
  ).setMimeType(ContentService.MimeType.JSON);
}
