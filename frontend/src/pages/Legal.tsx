import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Wordmark } from "../components/ui";
import "../styles/legal.css";

// Privacy Policy and Terms of Service for Vyrani Studios. Service providers are described by role, not by name.
const UPDATED = "21 October 2026";
const COMPANY = "Vyrani Studios";
const EMAIL = <a href="mailto:support@vyrani.com">support@vyrani.com</a>;

function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="legal">
      <header className="legal-top"><Wordmark /><nav><Link to="/privacy">Privacy</Link><Link to="/terms">Terms</Link></nav></header>
      <main className="legal-body">
        <h1>{title}</h1>
        <p className="legal-updated">Last updated {UPDATED}</p>
        {children}
      </main>
      <footer className="legal-foot"><Link to="/">Back to VYRANI</Link></footer>
    </div>
  );
}

export function Privacy() {
  return (
    <LegalPage title="Privacy Policy">
      <p>This policy explains what VYRANI ("we", "us") collects when you use vyrani.com, the VYRANI studio and the VYRANI browser
        extension, why, who else handles it, and how long we keep it. VYRANI is operated by {COMPANY}.
        Questions or requests: {EMAIL}.</p>

      <h2>The short version</h2>
      <ul>
        <li>We don't sell your data, show ads or use tracking cookies.</li>
        <li>Live camera video is processed in real time and is not stored on our servers.</li>
        <li>Photos, clips and voice samples you upload to make a video are deleted as soon as the video is finished. Finished videos are deleted after 7 days.</li>
        <li>You can delete your account yourself, at any time, in Settings.</li>
      </ul>

      <h2>What we collect</h2>
      <h3>Your account</h3>
      <p>Your email address, a securely hashed password (we never store the password itself) or your Google account ID if you sign in with
        Google, whether your email is verified, and when you joined.</p>
      <h3>Credits and payments</h3>
      <p>Your credit balance and a history of credit changes (purchases, live time, videos, refunds). Payments are handled by our payment
        processor. We receive the pack you bought, the amount and the processor's reference numbers. We never see or store your card details.</p>
      <h3>What you create</h3>
      <ul>
        <li><strong>Live sessions.</strong> Your camera video and the look you choose (text or a reference photo) are sent to our AI
          provider to change the picture in real time. We keep only the session's start, length and credits used.</li>
        <li><strong>Create video.</strong> The clip, reference photo and optional voice sample you upload are stored on our server only
          while your video is being made, then deleted. The finished video is kept for 7 days so you can download it, then deleted.</li>
        <li><strong>Recordings</strong> you make in the studio are created in your browser and saved to your device. They are not
          uploaded to us unless you choose to change their voice, in which case the audio is processed and not kept.</li>
        <li><strong>Livestreams</strong> you send to a platform such as YouTube or Twitch pass through our server on their way. We don't
          store them. Your stream key is used only for that stream and is never logged or saved.</li>
      </ul>
      <h3>The browser extension</h3>
      <p>The VYRANI extension passes the video and sound from your open VYRANI studio tab to the calling website you choose (such as
        Google Meet), entirely inside your browser. It doesn't send any data to us or anyone else, doesn't read the pages you visit, and
        only runs on vyrani.com and the supported calling sites. It saves two settings in your browser so it remembers your choices.</p>
      <h3>Technical information</h3>
      <p>Your IP address is used to protect sign-in and other actions from abuse and is deleted automatically within an hour. To keep the
        free trial to one per person, we keep a one-way scrambled code (a "hash") of your email address, and of your network address for
        30 days. Neither can be turned back into the original, and the email code stays even if you delete your account, so the trial
        can't be claimed again. Our servers keep short technical logs for security and fixing faults.</p>
      <h3>Cookies and storage</h3>
      <p>We use one essential cookie to keep you signed in (it lasts 14 days), a short-lived one during Google sign-in, and a random
        device code (kept for 2 years) used only to give the free trial once per device. It contains nothing about you. Your studio
        preferences, such as camera quality, are saved in your own browser and never sent to us.</p>

      <h2>Faces and voices</h2>
      <p>Photos of faces and samples of voices can be sensitive, and in some places count as biometric data. We use them only to make the
        result you asked for. We don't use them to identify anyone, we don't build face or voice profiles, and we don't use your
        content to train AI models. You must have the right to use any face or voice you upload (see our <Link to="/terms">Terms</Link>).</p>

      <h2>Who else handles your data</h2>
      <p>We use these service providers. Each receives only what it needs for its job, and handles it under its own terms and privacy policy:</p>
      <ul>
        <li><strong>AI processing providers</strong> run the models that change live video, make videos, change voices, write look
          descriptions and check photos.</li>
        <li><strong>A payment processor</strong> handles payments.</li>
        <li><strong>An email provider</strong> sends account emails (verification and password reset).</li>
        <li><strong>Google</strong>, only if you choose to sign in with Google.</li>
        <li><strong>Hosting, database and security providers</strong> run our servers, store account data and protect the website.</li>
      </ul>
      <p>These providers may process data in other countries, including the United States. We may also disclose information if the law
        requires it, or to protect people from harm or fraud.</p>

      <h2>Why we use your data</h2>
      <p>To provide the service you asked for (your account, sessions and videos), to take payment, to keep VYRANI safe and prevent abuse
        (including of the free trial), to email you about your account, and to meet legal duties such as keeping payment records.</p>

      <h2>How long we keep it</h2>
      <ul>
        <li>Uploads for Create video: deleted when the video is finished, failed or cancelled.</li>
        <li>Finished videos: 7 days.</li>
        <li>IP addresses for security: up to 1 hour. Network-address hashes for the free trial: 30 days. Email hashes for the free trial: kept.</li>
        <li>Your account: until you delete it. Credit and payment records are kept anonymously for as long as tax and accounting law
          requires.</li>
      </ul>

      <h2>Your choices and rights</h2>
      <p>You can see your email, sign-in methods and credit history in the app, and delete your account in Settings at any time. Deleting
        removes your email, sign-in details and videos; unused credits are lost. Depending on where you live, you may also have the right
        to a copy of your data, to correct it, or to object to or limit how we use it. Email {EMAIL} and we'll reply within 30 days. You
        can also complain to your local data protection authority.</p>

      <h2>Children</h2>
      <p>VYRANI is for people aged 18 and over. We don't knowingly collect data from children. If you believe a child has an account,
        email {EMAIL} and we'll delete it.</p>

      <h2>Security</h2>
      <p>Connections are encrypted, passwords are hashed, payments run through a certified payment processor and access to our systems is limited. No service can
        promise perfect security; if a breach affects you, we'll tell you as the law requires.</p>

      <h2>Changes</h2>
      <p>If we change this policy in a way that matters, we'll update the date above and tell signed-in users before it takes effect.</p>
    </LegalPage>
  );
}

export function Terms() {
  return (
    <LegalPage title="Terms of Service">
      <p>These terms are an agreement between you and {COMPANY} ("VYRANI", "we") for using vyrani.com, the VYRANI studio and the
        browser extension. By creating an account or using VYRANI, you agree to them and to our <Link to="/privacy">Privacy Policy</Link>.</p>

      <h2>1. Who can use VYRANI</h2>
      <p>You must be 18 or older and able to enter a contract. One person per account; keep your sign-in details private. You are
        responsible for what happens under your account.</p>

      <h2>2. Consent: whose face and voice you may use</h2>
      <p>This is the rule that matters most. You may only use a face or voice that is <strong>yours</strong>, that belongs to an
        <strong> AI-generated person</strong>, or that belongs to someone who has <strong>clearly agreed</strong> to this use. You must be
        able to show that agreement if asked. Never use someone's likeness or voice without their permission.</p>

      <h2>3. Things you must not do</h2>
      <ul>
        <li>Pretend to be a real person to deceive anyone, including in calls, interviews, exams, or identity or age checks.</li>
        <li>Commit or attempt fraud, scams, blackmail or financial deception.</li>
        <li>Make sexual or intimate content of anyone, or any content involving a minor.</li>
        <li>Harass, bully, threaten or defame anyone, or make content that promotes hatred or violence.</li>
        <li>Mislead people about elections, public health or emergencies, or present a public figure saying or doing things they didn't.</li>
        <li>Remove or hide VYRANI's AI label to make people believe AI content is real.</li>
        <li>Break the law, others' rights (including copyright and privacy), or the rules of the platforms and calls you use VYRANI on.</li>
        <li>Abuse the service: share accounts, farm free trials, attack or overload our systems, or copy or resell VYRANI.</li>
      </ul>
      <p>Where the law or the setting requires it, tell the people you're talking to that your video is AI-altered. We may suspend or close
        accounts that break these rules, without a refund for misuse, and report illegal activity to the authorities.</p>

      <h2>4. AI labels</h2>
      <p>Videos made with VYRANI carry a mark that says they were made with AI, and the studio can show a visible VYRANI label. AI results
        can be imperfect or unexpected; review them before sharing.</p>

      <h2>5. Credits and payment</h2>
      <ul>
        <li>Credits are prepaid. One credit is one second of live video; other tools show their credit cost before you use them.</li>
        <li>Live time is taken in 30-second blocks. Unused time in a block is returned when the session ends.</li>
        <li>If a session or video fails on our side, its credits are returned automatically.</li>
        <li>Credits don't expire while your account is open, have no cash value and can't be transferred. They're lost if you delete your
          account or it's closed for breaking these terms.</li>
        <li>Prices are shown in the app before you pay, and payments are handled by our payment processor.</li>
        <li><strong>All credit purchases are final and non-refundable</strong>, except where the law says otherwise or a payment was taken
          in error. If a payment is reversed or refunded, the credits it bought are removed.</li>
        <li>New accounts may receive a small free trial, once per person. We may withhold or remove it if we see signs of abuse.</li>
      </ul>

      <h2>6. Your content</h2>
      <p>You keep the rights to what you upload and create. You give us permission to process it only to provide VYRANI to you (for
        example, to send it to our AI providers and return your result). We don't use your content to train AI models. You confirm you
        have the rights needed for everything you upload.</p>

      <h2>7. Our service</h2>
      <p>VYRANI relies on third-party AI and infrastructure providers. We work to keep it running well, but it's provided "as is": we
        can't promise it will always be available, error-free, or that results will meet your expectations. We may change or stop
        features, and will give reasonable notice before closing the service.</p>

      <h2>8. Liability</h2>
      <p>To the extent the law allows, we aren't liable for indirect or consequential losses, or for how you or others use content made
        with VYRANI. Our total liability to you is limited to the amount you paid us in the 12 months before the claim. Nothing here
        limits rights you have under consumer law that can't be excluded.</p>

      <h2>9. You protect us</h2>
      <p>If someone makes a claim against us because of content you made or a rule you broke, you agree to cover the reasonable costs, to
        the extent the law allows.</p>

      <h2>10. Ending your account</h2>
      <p>You can delete your account in Settings at any time. We may suspend or close accounts that break these terms or the law.</p>

      <h2>11. Changes and law</h2>
      <p>We may update these terms; for significant changes we'll tell signed-in users before they apply. These terms are governed by the
        laws of the country where {COMPANY} is registered, and disputes go to its courts, unless your local consumer law says
        otherwise.</p>

      <h2>12. Contact</h2>
      <p>{COMPANY}. Email {EMAIL}.</p>
    </LegalPage>
  );
}
