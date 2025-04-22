<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>Розклад уроків - 4 клас</title>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
  <style>
    body {
      font-family: 'Montserrat', sans-serif;
      margin: 0;
      padding: 0;
      background-image: url('https://zastavki.gas-kvas.com/uploads/posts/2024-09/zastavki-gas-kvas-com-35bo-p-zastavki-pro-shkolu-9.jpg');
      background-size: cover;
      background-position: center;
      background-attachment: fixed;
      min-height: 100vh;
      transition: background 0.5s ease, color 0.5s ease;
      position: relative;
      font-size: 16px;
      color: #333;
    }

    body.dark-theme {
      background: linear-gradient(135deg, rgba(0, 43, 51, 0.6) 0%, rgba(0, 77, 87, 0.6) 100%), url('https://zastavki.gas-kvas.com/uploads/posts/2024-09/zastavki-gas-kvas-com-35bo-p-zastavki-pro-shkolu-9.jpg');
      background-size: cover;
      background-position: center;
      background-attachment: fixed;
      color: #fff;
    }

    header {
      background: linear-gradient(45deg, #00bfd1, #006d77);
      color: white;
      padding: 1.5rem 0;
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 1rem;
      box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      position: relative;
    }

    body.dark-theme header {
      background: linear-gradient(45deg, #003d44, #006d77);
    }

    header img {
      width: 100px;
      height: 100px;
      border-radius: 50%;
      border: 3px solid rgba(255,255,255,0.2);
      opacity: 0;
      animation: fadeInHeader 1s ease-in forwards 1.5s;
    }

    header h1 {
      font-size: 1.8rem;
      margin: 0;
      font-weight: 700;
      text-shadow: 0 2px 4px rgba(0,0,0,0.2);
      animation: fadeIn 1s ease-in;
    }

    .theme-toggle, .notify-toggle {
      position: absolute;
      top: 1rem;
      background: none;
      border: none;
      color: white;
      font-size: 1.5rem;
      cursor: pointer;
      padding: 0.5rem;
    }

    .theme-toggle { right: 3.5rem; }
    .notify-toggle { right: 1rem; }

    .lang-switcher {
      position: absolute;
      top: 1rem;
      left: 1rem;
      display: flex;
      gap: 0.5rem;
    }

    .lang-toggle {
      background: none;
      border: 1px solid white;
      border-radius: 4px;
      color: white;
      font-size: 1rem;
      cursor: pointer;
      padding: 0.5rem;
      transition: background 0.3s ease;
    }

    .lang-toggle:hover {
      background: rgba(255,255,255,0.2);
    }

    .lang-toggle.active {
      background: white;
      color: #006d77;
    }

    @media screen and (max-width: 480px) {
      .lang-switcher {
        flex-direction: column;
        top: 0.5rem;
        left: 0.5rem;
      }

      .lang-toggle {
        padding: 0.4rem;
        font-size: 0.9rem;
      }
    }

    .logo-intro {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 120px;
      height: 120px;
      border-radius: 50%;
      border: 3px solid rgba(255,255,255,0.2);
      animation: logoIntro 1s ease-in-out forwards;
      z-index: 1000;
    }

    @keyframes logoIntro {
      0% { opacity: 0; transform: translate(-50%, -50%) scale(0.5); }
      50% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      100% { opacity: 0; transform: translate(-50%, -50%) scale(1.1); }
    }

    @keyframes fadeInHeader {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .container {
      max-width: 2000px;
      margin: 2rem auto;
      padding: 0 1rem;
      display: flex;
      gap: 1.5rem;
      justify-content: center;
      animation: fadeInUp 0.8s ease-in;
    }

    .current-lesson {
      font-size: 1.2rem;
      color: #1a1a66;
      background: white;
      border-left: 6px solid #4CAF50;
      padding: 1rem;
      margin: 0 0 1.5rem;
      border-radius: 12px;
      box-shadow: 0 5px 15px rgba(0,0,0,0.08);
      transition: transform 0.3s ease, box-shadow 0.3s ease;
    }

    body.dark-theme .current-lesson {
      background: #333;
      color: #fff;
    }

    .current-lesson:hover {
      transform: translateY(-5px);
      box-shadow: 0 8px 20px rgba(0,0,0,0.12);
    }

    .day-filter {
      display: flex;
      justify-content: center;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
    }

    .day-filter button {
      padding: 0.8rem 1rem;
      border: none;
      background: #f8f9fa;
      border-radius: 8px;
      cursor: pointer;
      transition:
