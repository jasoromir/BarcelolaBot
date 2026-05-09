#!/usr/bin/env tsx
import { createWixClient } from '../src/wix/client.js';

const WIX_API_KEY = process.env.WIX_API_KEY!;
const WIX_SITE_ID = process.env.WIX_SITE_ID!;

async function main() {
  console.log('Fetching tomorrow\'s tours from Wix...\n');

  const wixClient = createWixClient({ apiKey: WIX_API_KEY, siteId: WIX_SITE_ID });

  // Get tomorrow's date
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toISOString().split('T')[0]; // YYYY-MM-DD

  const tours = await wixClient.getToursForDate(dateStr);

  console.log(`Found ${tours.length} tours for ${dateStr}:\n`);

  for (const tour of tours) {
    console.log('━'.repeat(70));
    console.log(`Tour: ${tour.title}`);
    console.log(`Service ID: ${tour.serviceId}`);
    console.log(`Time: ${tour.startTime} - ${tour.endTime}`);
    console.log(`Location: ${tour.location || 'N/A'}`);
    console.log(`Participants: ${tour.participantCount}`);
    console.log(`Bookings: ${tour.bookings.length}`);

    // Show guides if available
    if (tour.staff && tour.staff.length > 0) {
      console.log(`Guides: ${tour.staff.map(s => s.name).join(', ')}`);
    }

    // Show participant breakdown
    console.log('\nParticipants:');
    tour.bookings.forEach(booking => {
      console.log(`  • ${booking.contactName} - ${booking.numberOfParticipants} people`);
    });
    console.log('');
  }

  console.log('━'.repeat(70));
  console.log(`\nTotal: ${tours.length} tours, ${tours.reduce((sum, t) => sum + t.participantCount, 0)} participants\n`);

  // Now build the Hebrew message
  console.log('Building Hebrew message...\n');

  const hebrewMessage = buildHebrewMessage(tours, dateStr);
  console.log(hebrewMessage);

  console.log('\n' + '━'.repeat(70));
  console.log('Guide assignments:\n');

  const guideInfo = buildGuideInfo(tours);
  console.log(guideInfo);
}

function buildHebrewMessage(tours: any[], date: string) {
  const weekdays = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const dateObj = new Date(date);
  const weekday = weekdays[dateObj.getDay()];
  const formattedDate = `${dateObj.getDate()}.${dateObj.getMonth() + 1}`;

  let message = `*לילה טוב לכל המטיילים והמטיילות האהובים מ- Barcelola Tours ✨🌜*\n\n`;
  message += `❤️ *לנמצאים בברצלונה - הצטרפו לסיורי ברצלולה, מחר יום ${weekday} ה-${formattedDate}* ❤️\n\n`;
  message += `*סיורים חינם על בסיס טיפ בתוך העיר*\n\n`;

  // Add each tour
  for (const tour of tours) {
    const tourInfo = getTourInfo(tour.serviceId, tour.title);
    message += `${tourInfo.emoji} ${tour.startTime}-${tour.endTime}\n`;
    message += `*${tourInfo.nameHe}*\n`;
    message += `${tourInfo.descriptionHe}\n`;
    message += `*נקודת ושעת מפגש* - ${tourInfo.meetingPoint}\n\n`;
  }

  // Add footer
  message += `🌻 *למידע נוסף והרשמה לסיורים הכנסו לאתר שלנו:*\n`;
  message += `https://www.barcelola-tours.com/barcelolatours\n\n`;
  message += `🌻בואו גם ל *קבוצת הפייסבוק* שלנו!\n`;
  message += `https://www.facebook.com/groups/barcelolatours/?ref=share`;

  return message;
}

function buildGuideInfo(tours: any[]) {
  let info = '';

  for (const tour of tours) {
    const guideName = tour.staff && tour.staff.length > 0 ? tour.staff[0].name : 'לא משובץ';
    info += `🌻 *${tour.title}* (${tour.startTime})\n`;
    info += `   מדריך/ה: ${guideName}\n`;
    info += `   מספר משתתפים: ${tour.participantCount}\n\n`;
  }

  return info;
}

function getTourInfo(serviceId: string, title: string) {
  // Known tour from Wix
  if (serviceId === '4422ee5f-957b-45c8-bf06-876482fd2b57') {
    return {
      emoji: '🌻',
      nameHe: 'גותיראמבלה ללא הפסקה',
      descriptionHe: 'בסיור נלמד ונכיר את הקטלאני המפורסם מכולם - אנטוני גאודי. נראה את הבתים המפורסמים שלו, נבין מה הופך אותו לאדריכל כל כך ייחודי ונגלה סיפורים מרתקים על חייו.',
      meetingPoint: '10:15 בכניסה למסעדת הארד רוק קפה, פלאסה קטלוניה',
    };
  }

  // Generate description for unknown tours
  return {
    emoji: '🌻',
    nameHe: title,
    descriptionHe: `סיור מיוחד בברצלונה - ${title}. הצטרפו אלינו לחוויה בלתי נשכחת בעיר המדהימה הזו!`,
    meetingPoint: 'נקודת המפגש תישלח בהודעה נפרדת',
  };
}

main().catch(console.error);
