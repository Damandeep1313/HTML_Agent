/*******************************************************
 * server.js
 *
 * 1) INSTALL DEPENDENCIES:
 *    npm install express openai axios dotenv adm-zip sharp cloudinary
 *
 * 2) CREATE .env FILE with keys:
 *    OPENAI_API_KEY=sk-...
 *    NETLIFY_SITE_ID=...
 *    CLOUDINARY_CLOUD_NAME=...
 *    CLOUDINARY_API_KEY=...
 *    CLOUDINARY_API_SECRET=...
 *
 * 3) RUN:
 *    node server.js
 *
 * 4) TEST (example):
 *    curl -X POST http://localhost:3000/nl-generate-landing-page \
 *      -H "Content-Type: application/json" \
 *      -H "netlify-auth-token: <YOUR_TOKEN_HERE>" \
 *      -d '{"textPrompt": "...some instructions..."}'
 *******************************************************/

// Load environment variables
require("dotenv").config();

const express    = require("express");
const axios      = require("axios");
const AdmZip     = require("adm-zip");
const sharp      = require("sharp");
const cloudinary = require("cloudinary").v2;

// Official OpenAI library
const { Configuration, OpenAIApi } = require("openai");

const app = express();
app.use(express.json());

// ----------------------------------------------------
// 0) CONFIGURE CLOUDINARY (for image compression+upload)
// ----------------------------------------------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// A helper function that tries to compress an image buffer
// under the target size by lowering quality in steps.
async function compressImageToUnder(buffer, targetSizeKB = 250) {
  let quality = 90; // start at 90% JPEG quality
  while (quality > 10) {
    const compressed = await sharp(buffer)
      .jpeg({ quality, force: true })
      .toBuffer();
    const sizeKB = Math.round(compressed.length / 1024);
    if (sizeKB <= targetSizeKB) {
      console.log(`Compression success at quality=${quality}, size=${sizeKB}KB`);
      return compressed;
    }
    quality -= 10; // lower quality if still too big
  }
  // If we exit the loop, just return final attempt at ~10% quality
  console.log(`Could not get below ${targetSizeKB}KB, returning last attempt.`);
  return await sharp(buffer).jpeg({ quality: 10, force: true }).toBuffer();
}

// Download, compress, upload to Cloudinary, return new URL
async function fetchCompressUpload(originalUrl) {
  try {
    // 1) Download the image as array buffer
    const resp = await axios.get(originalUrl, { responseType: "arraybuffer" });
    const originalBuffer = Buffer.from(resp.data);
    console.log("Original size (KB) =", Math.round(originalBuffer.length / 1024));

    // 2) Compress
    const compressedBuffer = await compressImageToUnder(originalBuffer, 250);
    console.log("Compressed size (KB) =", Math.round(compressedBuffer.length / 1024));

    // 3) Upload to Cloudinary
    const uploadResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { folder: "compressed-images" }, // optional folder
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(compressedBuffer);
    });

    console.log("Cloudinary upload success =>", uploadResult.secure_url);
    return uploadResult.secure_url;
  } catch (err) {
    console.error("Error in fetchCompressUpload:", err.message);
    // Throw here so we can either catch/fallback or bubble up
    throw new Error(`Failed to compress+upload image from URL: ${originalUrl}`);
  }
}

// ----------------------------------------------------
// 1) SETUP OPENAI
// ----------------------------------------------------
const openaiConfig = new Configuration({
  apiKey: process.env.OPENAIA_API_KEY || process.env.OPENAI_API_KEY, 
});
const openai = new OpenAIApi(openaiConfig);

// ----------------------------------------------------
// 2) NETLIFY DEPLOY FUNCTION
//    NOTE: Netlify token is now read from request headers
//    but we still read the SITE_ID from .env
// ----------------------------------------------------
const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID;

async function deployHtmlToNetlify(htmlString, netlifyToken) {
  console.log("deployHtmlToNetlify: Starting deploy to Netlify...");

  if (!netlifyToken) {
    throw new Error("Missing Netlify Auth Token in request header!");
  }
  if (!NETLIFY_SITE_ID) {
    throw new Error("Missing NETLIFY_SITE_ID in .env");
  }

  // Zip index.html in memory
  console.log("deployHtmlToNetlify: Zipping HTML in memory...");
  const zip = new AdmZip();
  zip.addFile("index.html", Buffer.from(htmlString, "utf8"));
  const zipBuffer = zip.toBuffer();
  console.log("deployHtmlToNetlify: zip size =", zipBuffer.length, "bytes");

  // Deploy to Netlify
  const url = `https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/deploys`;
  console.log("deployHtmlToNetlify: POST ->", url);

  const response = await axios.post(url, zipBuffer, {
    headers: {
      "Content-Type": "application/zip",
      Authorization: `Bearer ${netlifyToken}`,
    },
  });

  const deployUrl = response.data.deploy_url || response.data.url;
  console.log("deployHtmlToNetlify: SUCCESS, Netlify URL =", deployUrl);
  return deployUrl;
}

// ----------------------------------------------------
// 3) HELPER: GENERATE HTML FROM PARSED JSON
// ----------------------------------------------------

// Default testimonial images if none provided
const DEFAULT_T1 =
  "https://media.istockphoto.com/id/1329039896/photo/young-doctor-asking-senior-impaired-male-patient-in-wheelchair-to-sign-insurance-policy-at.jpg";
const DEFAULT_T2 = "https://picsum.photos/80/80?random=203";
const DEFAULT_T3 = "https://picsum.photos/80/80?random=201";

function generateLandingPageHtml(parsedData) {
  console.log("generateLandingPageHtml: Building final HTML...");

  const {
    websiteNiche,
    doctorDetails,
    pageLinks = [],
    images = [],
    testimonialImages = [],
    faqs = [],
  } = parsedData;

  if (!websiteNiche || !doctorDetails || !doctorDetails.name) {
    throw new Error("Missing required fields: websiteNiche, doctorDetails.name, etc.");
  }

  // Hero/About image
  const mainImage = images[0] || "https://via.placeholder.com/1200x600?text=No+Hero+Image";

  // Arrays
  const specializationList = Array.isArray(doctorDetails.specialization)
    ? doctorDetails.specialization
    : [];
  const achievementsList = Array.isArray(doctorDetails.achievements)
    ? doctorDetails.achievements
    : [];
  const descriptionText = doctorDetails.description || "";

  // Testimonial images (fallback to defaults)
  const t1 = testimonialImages[0] || DEFAULT_T1;
  const t2 = testimonialImages[1] || DEFAULT_T2;
  const t3 = testimonialImages[2] || DEFAULT_T3;

  // Build final HTML string
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Luxury Services – ${doctorDetails.name} | ${websiteNiche.toUpperCase()} Prestige</title>
  <meta name="description" content="${doctorDetails.name} is a leading specialist in the ${websiteNiche} field. This page showcases specializations, achievements, and more." />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />

  <!-- Bootstrap 5 CSS -->
  <link
    href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"
    rel="stylesheet"
  >
  <!-- Bootstrap Icons (for styling bullet points) -->
  <link
    rel="stylesheet"
    href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/font/bootstrap-icons.css"
  >
  <!-- AOS (Animate On Scroll) CSS -->
  <link
    rel="stylesheet"
    href="https://cdn.jsdelivr.net/npm/aos@2.3.1/dist/aos.css"
  />
  <!-- Google Fonts -->
  <link rel="preconnect" href="https://fonts.gstatic.com" />
  <link
    href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;500;700&display=swap"
    rel="stylesheet"
  >

  <style>
    body {
      font-family: 'Poppins', sans-serif;
      color: #333;
      background-color: #f9f9f9;
      overflow-x: hidden;
    }
    .navbar-brand {
      font-weight: 700;
    }
    /* Hero */
    .hero-section {
      position: relative;
      height: 75vh;
      background: url('${mainImage}') center center / cover no-repeat fixed;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      text-shadow: 2px 2px 6px rgba(0,0,0,0.5);
    }
    .hero-overlay {
      position: absolute;
      top: 0; right: 0; bottom: 0; left: 0;
      background: rgba(0,0,0,0.4);
    }
    .hero-content {
      position: relative;
      text-align: center;
      z-index: 2;
    }
    .hero-content h1 {
      font-size: 3rem;
      font-weight: 700;
    }
    .hero-content p {
      font-size: 1.3rem;
      font-weight: 300;
      margin-top: 0.5rem;
    }
    /* CTA Section */
    .cta-section {
      background: linear-gradient(135deg, #15aabf, #2fbfac);
      color: #fff;
      padding: 3rem 0;
      text-align: center;
    }
    .cta-section h2 {
      font-weight: 700;
      margin-bottom: 1rem;
    }
    .cta-section .btn-cta {
      background-color: #fff;
      color: #15aabf;
      font-weight: 600;
      border: none;
      padding: 0.75rem 1.5rem;
      border-radius: 50px;
      transition: background-color 0.3s ease;
    }
    .cta-section .btn-cta:hover {
      background-color: #eee;
    }

    /* Enhanced bullet styling for lists */
    .list-group-item {
      border: 0;
      padding-left: 0;
    }
    .list-group-item i {
      color: #2fbfac;
      margin-right: 0.5rem;
    }

    /* Testimonials */
    .testimonial-carousel .carousel-item {
      padding: 2rem;
    }
    .testimonial-carousel .carousel-item img {
      width: 80px;
      height: 80px;
      object-fit: cover;
      border-radius: 50%;
    }
    .testimonial-carousel .carousel-item blockquote {
      font-style: italic;
      margin: 1.5rem 0;
    }

    /* FAQ Section */
    .faq-section {
      background-color: #fff;
      padding: 3rem 0;
      margin-bottom: 3rem;
    }
    /* Description Section styling (within About) */
    .description-box {
      background: #fff3e6;
      border: 1px solid #ffd9b3;
      padding: 1.5rem;
      border-radius: 5px;
      margin-bottom: 1.5rem;
      line-height: 1.8;
      min-height: 220px;
      width: 95%;
      margin: 0 auto 1.5rem auto;
    }
    /* Appointment Form styling */
    .appointment-card {
      border: none;
      box-shadow: 0 2px 6px rgba(0,0,0,0.1);
      border-radius: 8px;
    }
    .appointment-card .card-body {
      padding: 2rem;
    }
    /* Footer */
    footer {
      background-color: #222;
      color: #bbb;
      padding: 2rem 0;
      text-align: center;
    }
    footer p {
      margin: 0;
    }
    /* AOS animations */
    [data-aos] {
      transition: transform 0.6s ease, opacity 0.6s ease;
    }
  </style>
</head>
<body>
  <!-- Navbar -->
  <nav class="navbar navbar-expand-lg navbar-dark bg-dark" data-aos="fade-down">
    <div class="container">
      <a class="navbar-brand" href="#">${doctorDetails.name}</a>
      <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarMenu">
        <span class="navbar-toggler-icon"></span>
      </button>
      <div class="collapse navbar-collapse" id="navbarMenu">
        <ul class="navbar-nav ms-auto">
          ${pageLinks.map(link => `
            <li class="nav-item">
              <a class="nav-link" href="/${link}">${link.replace('-', ' ')}</a>
            </li>
          `).join('')}
        </ul>
      </div>
    </div>
  </nav>
  
  <!-- Hero -->
  <section class="hero-section">
    <div class="hero-overlay"></div>
    <div class="hero-content" data-aos="zoom-in">
      <h1>Dr. ${doctorDetails.name}</h1>
      <p>Leading Specialist in ${websiteNiche}</p>
      <button class="btn btn-light mt-3" onclick="document.getElementById('appointment').scrollIntoView({ behavior: 'smooth' });">
        Book an Appointment
      </button>
    </div>
  </section>

  <!-- About Section -->
  <section class="container py-5">
    <div class="row">
      <!-- Left Column: Specializations, Achievements, etc. -->
      <div class="col-md-6" data-aos="fade-right">
        <h2>About Dr. ${doctorDetails.name}</h2>
        <p class="lead">
          Dedicated to offering the highest level of personalized care for every patient.
        </p>

        <!-- Specializations -->
        <h4>Specializations:</h4>
        <ul class="list-group list-group-flush mb-3">
          ${specializationList.map(spec => `
            <li class="list-group-item">
              <i class="bi bi-check-circle-fill"></i>
              ${spec}
            </li>
          `).join('')}
        </ul>

        <!-- Achievements -->
        <h4>Achievements:</h4>
        <ul class="list-group list-group-flush mb-3">
          ${achievementsList.map(ach => `
            <li class="list-group-item">
              <i class="bi bi-star-fill"></i>
              ${ach}
            </li>
          `).join('')}
        </ul>

        <!-- Description -->
        <h4 class="mb-2">Description:</h4>
        <div class="description-box">
          ${descriptionText}
        </div>
      </div>

      <!-- Right Column: Image -->
      <div class="col-md-6 text-center" data-aos="fade-left">
        <img src="${mainImage}" alt="Photo of Dr. ${doctorDetails.name}" class="img-fluid rounded shadow">
      </div>
    </div>
  </section>

  <!-- CTA Section -->
  <section class="cta-section" data-aos="fade-up">
    <div class="container">
      <h2>Experience Our World-Class Services</h2>
      <p class="mb-4">Book an appointment and discover the difference of dedicated, patient-centered care.</p>
      <button class="btn-cta" onclick="document.getElementById('appointment').scrollIntoView({ behavior: 'smooth' });">
        Book Now
      </button>
    </div>
  </section>

  <!-- Testimonial Carousel -->
  <section class="testimonial-carousel container py-5" data-aos="fade-up">
    <h2 class="text-center mb-4">What Our Patients Say</h2>
    <div id="carouselExample" class="carousel slide" data-bs-ride="carousel">
      <div class="carousel-inner">
        <!-- Slide 1 -->
        <div class="carousel-item active">
          <div class="text-center">
            <img src="${t1}" alt="Patient 1">
            <blockquote class="blockquote mt-3">
              "Dr. ${doctorDetails.name} is simply the best. I felt cared for from the moment I walked in!"
            </blockquote>
            <p class="fw-bold">- Happy Patient</p>
          </div>
        </div>
        <!-- Slide 2 -->
        <div class="carousel-item">
          <div class="text-center">
            <img src="${t2}" alt="Patient 2">
            <blockquote class="blockquote mt-3">
              "I wouldn't trust anyone else with my family's needs."
            </blockquote>
            <p class="fw-bold">- Satisfied Family</p>
          </div>
        </div>
        <!-- Slide 3 -->
        <div class="carousel-item">
          <div class="text-center">
            <img src="${t3}" alt="Patient 3">
            <blockquote class="blockquote mt-3">
              "Professional, caring, and highly experienced. 10/10 recommend!"
            </blockquote>
            <p class="fw-bold">- Grateful Patient</p>
          </div>
        </div>
      </div>
      <!-- Carousel Controls -->
      <button class="carousel-control-prev" type="button" data-bs-target="#carouselExample" data-bs-slide="prev">
        <span class="carousel-control-prev-icon" aria-hidden="true"></span>
      </button>
      <button class="carousel-control-next" type="button" data-bs-target="#carouselExample" data-bs-slide="next">
        <span class="carousel-control-next-icon" aria-hidden="true"></span>
      </button>
    </div>
  </section>

  <!-- FAQ Section -->
  <section class="faq-section container" data-aos="fade-up">
    <h2 class="text-center mb-4">Frequently Asked Questions</h2>
    <div class="accordion" id="faqAccordion">
      ${faqs.map((faq, index) => `
        <div class="accordion-item">
          <h2 class="accordion-header" id="heading${index}">
            <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse"
              data-bs-target="#collapse${index}" aria-expanded="false" aria-controls="collapse${index}">
              ${faq.question}
            </button>
          </h2>
          <div id="collapse${index}" class="accordion-collapse collapse"
               aria-labelledby="heading${index}" data-bs-parent="#faqAccordion">
            <div class="accordion-body">
              ${faq.answer}
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  </section>

  <!-- Appointment Form (Scroll Target) -->
  <section class="contact-section" id="appointment">
    <div class="container" data-aos="fade-up">
      <h2 class="text-center mb-5">Request an Appointment</h2>
      <div class="row justify-content-center">
        <div class="col-md-8">
          <div class="card appointment-card">
            <div class="card-body">
              <h4 class="card-title mb-3">Please fill in your details</h4>
              <form>
                <div class="mb-3">
                  <label for="name" class="form-label">Full Name</label>
                  <input type="text" class="form-control" id="name" placeholder="Your name" required>
                </div>
                <div class="mb-3">
                  <label for="email" class="form-label">Email Address</label>
                  <input type="email" class="form-control" id="email" placeholder="name@example.com" required>
                </div>
                <div class="mb-3">
                  <label for="date" class="form-label">Preferred Date</label>
                  <input type="date" class="form-control" id="date" required>
                </div>
                <div class="mb-3">
                  <label for="notes" class="form-label">Additional Notes</label>
                  <textarea class="form-control" id="notes" rows="3" placeholder="Any special requests or questions..."></textarea>
                </div>
                <button type="submit" class="btn btn-primary px-4">Submit</button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer>
    <div class="container">
      <p class="mb-2">&copy; ${new Date().getFullYear()} Dr. ${doctorDetails.name}. All rights reserved.</p>
      <p>Setting the gold standard in personalized healthcare for every walk of life.</p>
    </div>
  </footer>

  <!-- Bootstrap JS bundle -->
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  <!-- AOS Library JS -->
  <script src="https://cdn.jsdelivr.net/npm/aos@2.3.1/dist/aos.js"></script>
  <script>
    AOS.init({
      duration: 1000,
      once: true
    });
  </script>
</body>
</html>
  `;
  return html;
}

// ----------------------------------------------------
// 4) NATURAL LANGUAGE -> LLM -> JSON -> (Compress) -> Deploy to Netlify
// ----------------------------------------------------
app.post("/nl-generate-landing-page", async (req, res) => {
  try {
    const { textPrompt } = req.body;
    if (!textPrompt) {
      return res.status(400).json({ error: 'Missing "textPrompt" field' });
    }

    // Extract Netlify auth token from the request headers
    const netlifyAuthToken = req.headers["netlify-auth-token"];
    if (!netlifyAuthToken) {
      return res.status(400).json({ error: "Missing 'netlify-auth-token' header" });
    }

    // 1) System instructions for the LLM about how to parse
    const systemMessage = `You are a helpful assistant that converts unstructured text into a JSON object 
with the following structure exactly:

{
  "websiteNiche": string, 
  "doctorDetails": {
    "name": string,
    "specialization": [array of strings],
    "achievements": [array of strings],
    "description": string
  },
  "pageLinks": [array of strings],
  "images": [array of strings],
  "testimonialImages": [array of strings],
  "faqs": [ { "question": string, "answer": string }, ... ]
}

Return ONLY valid JSON, with NO extra text or explanation.
If any field is missing from user prompt, guess or fill placeholders.
ALWAYS respond with valid JSON. No code blocks, no extra text.
`;

    // 2) Build user message
    const userMessage = `User prompt:\n${textPrompt}\n\nPlease extract into the required JSON.`;

    // 3) Call OpenAI
    console.log("/nl-generate-landing-page: calling openai createChatCompletion...");
    const chatResponse = await openai.createChatCompletion({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage },
      ],
      temperature: 0,
    });

    const rawAssistantReply = chatResponse.data.choices[0].message.content;
    console.log("/nl-generate-landing-page: rawAssistantReply =\n", rawAssistantReply);

    // 4) Attempt to parse JSON
    let parsed;
    try {
      parsed = JSON.parse(rawAssistantReply);
    } catch (e) {
      console.error("OpenAI JSON parse error:", e);
      return res
        .status(500)
        .send("LLM did not return valid JSON:\n" + rawAssistantReply);
    }

    // 4.5) For each image in parsed.images + parsed.testimonialImages => compress+upload
    if (Array.isArray(parsed.images)) {
      for (let i = 0; i < parsed.images.length; i++) {
        const originalUrl = parsed.images[i];
        try {
          const newUrl = await fetchCompressUpload(originalUrl);
          parsed.images[i] = newUrl; // replace with new Cloudinary URL
        } catch (err) {
          console.log("Error compressing image:", originalUrl, err.message);
          // fallback to original
          // parsed.images[i] = originalUrl;
        }
      }
    }
    if (Array.isArray(parsed.testimonialImages)) {
      for (let j = 0; j < parsed.testimonialImages.length; j++) {
        const originalTUrl = parsed.testimonialImages[j];
        try {
          const newTUrl = await fetchCompressUpload(originalTUrl);
          parsed.testimonialImages[j] = newTUrl;
        } catch (err) {
          console.log("Error compressing testimonial image:", originalTUrl, err.message);
          // fallback to original
          // parsed.testimonialImages[j] = originalTUrl;
        }
      }
    }

    // 5) Generate HTML from that JSON
    const finalHtml = generateLandingPageHtml(parsed);

    // 6) Deploy the HTML to Netlify (pass the token from headers)
    const netlifyUrl = await deployHtmlToNetlify(finalHtml, netlifyAuthToken);

    // 7) Return the Netlify URL
    return res.status(200).json({
      success: true,
      netlifyUrl,
      note: "Images compressed & uploaded to Cloudinary, then deployed to Netlify (token from headers).",
    });
  } catch (err) {
    console.error("Error in /nl-generate-landing-page:", err);
    return res.status(500).json({ error: "Error processing natural language prompt" });
  }
});

// ----------------------------------------------------
// START THE SERVER
// ----------------------------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Landing Page Generator is running at http://localhost:" + port);
});
